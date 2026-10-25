import {
  type CallEndpointRequest,
  type CallEndpointResult,
  hasService,
  type LogErrors,
  type LogErrorsRequest,
  type LogSource,
  type LogTail,
  type LogTailRequest,
  type MiseTasks,
  type RepoCardResult,
  type RepoGraph,
  type RunningMiseTask,
  type RunState,
  SERVICE_MISE_TASK,
  type Service,
  type ServiceSlice,
  type SliceMember,
  type StartServiceRequest,
  type StopServiceRequest,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { callEndpoint } from "./endpoint-call.ts";
import { probePort } from "./port-probe.ts";
import { ServiceWatch, type WatchedRun } from "./service-watch.ts";
import { planSlice, type SlicePlan } from "./slice-plan.ts";

/**
 * Module `services` (§4, §4.3, ADR-45): a service is a repo and its mise task `dev`. A start brings up the slice, the
 * repo and the repos it calls at runtime from the graph, dependencies first, and watches each run until it is ready
 * (its port answers) or has ended. An endpoint call goes only to the port of a running service and returns the
 * response with the errors that appeared in the service logs meanwhile. State lives in memory: the process groups do
 * not outlive the daemon either (§4.1).
 */

/** What `services` needs from `mise`: the task `dev` started from the current list, as the button in the UI does. */
interface ServicesMise {
  tasks(repo: string): Promise<MiseTasks>;
  start(repo: string, miseTask: string): Promise<RunState>;
  stop(repo: string, miseTask: string): Promise<RunState>;
  run(repo: string, miseTask: string): RunState | undefined;
  running(): RunningMiseTask[];
}

/** What `services` needs from `logs`: the log of the task `dev` and its errors (ADR-28, ADR-42). */
interface ServicesLogs {
  tail(request: LogTailRequest): LogTail;
  errors(request: LogErrorsRequest): LogErrors;
  mask(text: string, env: NodeJS.ProcessEnv): string;
  runStartCursor(): number;
}

export interface ServicesDeps {
  mise: ServicesMise;
  logs: ServicesLogs;
  graph: { graph(): Promise<RepoGraph> };
  cards: { card(repo: string): Promise<RepoCardResult> };
  /** Environment of the processes started for the user; its secret values are masked in responses. */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** How often a watch checks a running service (500 ms in the daemon). */
  intervalMs: number;
  /** How long a service may be `starting` before it is `unhealthy` (5 minutes in the daemon: Gradle compiles first). */
  startupMs: number;
  /** How long to keep reading logs after a response, for errors logged after it was sent (500 ms in the daemon). */
  settleMs: number;
}

/** Errors per crashed or unhealthy member: the cause is usually in the first few. */
const MEMBER_ERRORS = 5;
/** Errors returned with an endpoint call. */
const CALL_ERRORS = 20;

type Member = Pick<SliceMember, "outcome" | "problem">;

/**
 * One start of a slice. `running` while its waves go on; a stop of the root makes it `cancelled` (no further wave,
 * no member starts after that) and a later start makes a new one.
 */
interface SliceRun {
  root: string;
  dependencies: boolean;
  status: "running" | "cancelled" | "done";
  /** The plan, once the graph has been read; a refused plan (too many repos) rejects. */
  planned: Promise<SlicePlan>;
  plan: SlicePlan | undefined;
  members: Map<string, Member>;
  /** Members an earlier start of the same root `started` that this one does not include: a stop with dependencies stops them too. */
  inherited: readonly string[];
  done: Promise<void>;
}

export class Services {
  private readonly deps: ServicesDeps;
  /** The watch of the latest run of each repo's service, in the order of the first start. */
  private readonly watches = new Map<string, ServiceWatch>();
  /** The latest start of each root repo; `stop` with dependencies stops what it started. */
  private readonly slices = new Map<string, SliceRun>();
  /** Starts in progress per repo, so two slices that share a dependency start it once and a stop can wait for them. */
  private readonly starting = new Map<string, Promise<Member>>();

  constructor(deps: ServicesDeps) {
    this.deps = deps;
  }

  /** Watched services, with a `dev` started elsewhere (the mise tasks tab, `run_mise_task`) adopted first. */
  async list(): Promise<Service[]> {
    for (const task of this.deps.mise.running()) if (task.miseTask === SERVICE_MISE_TASK) await this.adopt(task.repo);
    return [...this.watches.values()].map((w) => w.view());
  }

  /**
   * Starts the service of `repo` (and with `dependencies` its slice) and waits up to `waitMs` for the slice to settle;
   * the start goes on in the background. A service that already runs is not started again, so calling again waits
   * further; a crashed one starts again. A repo without the mise task `dev` is `not_found`, before anything starts.
   */
  async start({ repo, dependencies, waitMs }: StartServiceRequest): Promise<ServiceSlice> {
    const problem = await this.serviceProblem(repo);
    if (problem) throw new DomainError(problem.code, problem.message);
    // No `await` between the lookup and the registration: two starts at once share one slice.
    let slice = this.slices.get(repo);
    if (slice?.status === "running" && slice.dependencies !== dependencies) {
      // Replacing it would start the repo before the dependencies of the other plan, or leave them out of a stop's reach.
      const other = dependencies ? "without" : "with";
      throw new DomainError("bad_request", `a start of ${repo} ${other} dependencies is in progress: wait for it or stop it first`);
    }
    if (slice?.status !== "running") {
      slice = this.bringUp(repo, dependencies, slice);
      this.slices.set(repo, slice);
    }
    await slice.planned;
    const waited = new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref());
    await Promise.race([slice.done, waited]);
    return this.sliceView(slice);
  }

  /**
   * Stops the service of `repo` and, with `dependencies`, the services its starts started, except the ones
   * another running slice uses. A start in progress is cancelled first: no member starts after that, and members whose
   * start was already under way are stopped once they run. Returns the stopped services.
   */
  async stop({ repo, dependencies }: StopServiceRequest): Promise<Service[]> {
    const slice = this.slices.get(repo);
    // A root that crashed or was skipped may still have dependencies its start started.
    if (!slice && !this.liveRun(repo)) throw new DomainError("not_found", `the service of ${repo} has not been started`);
    if (slice?.status === "running") slice.status = "cancelled";
    const members = slice ? [...slice.members.keys()] : [repo];
    await Promise.all(members.map((r) => this.starting.get(r)));
    const repos = [repo, ...(dependencies && slice ? this.ownDependencies(slice) : [])];
    const stopped = await Promise.all(repos.map((r) => this.stopOne(r)));
    return stopped.filter((s) => s !== null);
  }

  /**
   * An HTTP request to the running service of `repo` (ADR-45), and the errors that appeared in the logs of the mise
   * task `dev` of every repo from just before the request until `settleMs` after the response.
   */
  async call(request: CallEndpointRequest): Promise<CallEndpointResult> {
    const watch = (await this.adopt(request.repo)) ?? this.watches.get(request.repo);
    const view = watch && (await watch.refresh());
    const address = watch?.reachable();
    if (!view || !address) {
      const why = view ? `is ${view.state}${view.reason ? ` (${view.reason})` : ""}` : "has not been started";
      throw new DomainError("service_unavailable", `the service of ${request.repo} ${why}`);
    }
    const cursor = this.logCursor(request.repo);
    const env = await this.deps.env();
    const result = await callEndpoint(address, request, (text) => this.deps.logs.mask(text, env));
    await new Promise((resolve) => setTimeout(resolve, this.deps.settleMs));
    const { errors } = this.deps.logs.errors({ miseTask: SERVICE_MISE_TASK, minLevel: "error", sinceSeq: cursor, limit: CALL_ERRORS });
    return { ...result, errors };
  }

  private bringUp(root: string, dependencies: boolean, previous: SliceRun | undefined): SliceRun {
    const edges = dependencies ? this.deps.graph.graph().then((g) => g.edges) : Promise.resolve([]);
    const slice: SliceRun = {
      root,
      dependencies,
      status: "running",
      planned: edges.then((e) => planSlice(e, root)),
      plan: undefined,
      members: new Map(),
      inherited: previous ? this.startedDependencies(previous) : [],
      done: Promise.resolve(),
    };
    slice.done = slice.planned
      .then(async (plan) => {
        slice.plan = plan;
        for (const repo of plan.waves.flat()) slice.members.set(repo, { outcome: "pending", problem: null });
        for (const wave of plan.waves) {
          if (slice.status !== "running") return;
          await Promise.all(wave.map((r) => this.ensure(slice, r)));
        }
      })
      .finally(() => {
        if (slice.status === "running") slice.status = "done";
        for (const [repo, member] of slice.members) {
          if (member.outcome === "pending") slice.members.set(repo, skipped("not started: the start was cancelled by a stop or failed"));
        }
      });
    // A refused plan reaches the caller through `planned`; `done` only ends the slice.
    slice.done.catch(() => {});
    return slice;
  }

  /** Brings one member up and resolves once it has settled; its outcome is set as soon as it is known. */
  private async ensure(slice: SliceRun, repo: string): Promise<void> {
    const running = await this.adopt(repo);
    if (running) {
      slice.members.set(repo, { outcome: "running", problem: null });
      return running.settled();
    }
    let start = this.starting.get(repo);
    if (!start) {
      start = this.startOne(slice, repo).finally(() => this.starting.delete(repo));
      this.starting.set(repo, start);
    }
    slice.members.set(repo, await start);
    await this.watches.get(repo)?.settled();
  }

  /**
   * Starts one service. Checks mise again even for the root: dependency waves can take minutes, and the config may
   * have changed meanwhile.
   */
  private async startOne(slice: SliceRun, repo: string): Promise<Member> {
    const problem = await this.serviceProblem(repo);
    if (problem) return skipped(problem.message);
    const cardPorts = await this.cardPorts(repo);
    for (const port of cardPorts) if (await probePort(port)) return skipped(this.portTaken(port));
    const cursor = this.logCursor(repo);
    // Right before the start: a stop that came meanwhile wins, unless another running slice still needs the service.
    if (slice.status === "cancelled" && !this.wanted(repo)) return skipped("the start was cancelled by a stop");
    try {
      this.watch({ repo, run: await this.deps.mise.start(repo, SERVICE_MISE_TASK), cardPorts, cursor });
      return { outcome: "started", problem: null };
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      return skipped(`${err.code}: ${err.message}`);
    }
  }

  private async stopOne(repo: string): Promise<Service | null> {
    const watch = await this.adopt(repo);
    if (!watch) return null;
    await this.deps.mise.stop(repo, SERVICE_MISE_TASK);
    return watch.refresh();
  }

  /** Why a port from the card that answers before the start is not this service's. */
  private portTaken(port: number): string {
    const holder = [...this.watches.values()].find((w) => w.view().port === port && this.liveRun(w.repo));
    if (holder) return `port ${port} (server.port on the card) is used by the service of ${holder.repo}`;
    return `port ${port} (server.port on the card) is already in use by a program Trackwall did not start`;
  }

  /**
   * The watch of the service's live run, also for a `dev` started elsewhere, which gets a watch here reading its log
   * from the oldest buffered record; `undefined` when the task does not run.
   */
  private async adopt(repo: string): Promise<ServiceWatch | undefined> {
    const run = this.liveRun(repo);
    if (!run) return undefined;
    const current = this.watches.get(repo);
    if (current?.runId === run.runId) return current;
    return this.watch({ repo, run, cardPorts: await this.cardPorts(repo), cursor: this.deps.logs.runStartCursor() });
  }

  /** The watch of a run, made once; it replaces the watch of an older run of the same service. */
  private watch(watched: WatchedRun): ServiceWatch {
    const { repo, run } = watched;
    const current = this.watches.get(repo);
    if (current?.runId === run.runId) return current;
    current?.dispose();
    const source = devSource(repo);
    const watch = new ServiceWatch(watched, {
      run: () => this.deps.mise.run(repo, SERVICE_MISE_TASK),
      tail: (page) => this.deps.logs.tail({ source, ...page }),
      probe: probePort,
      intervalMs: this.deps.intervalMs,
      startupMs: this.deps.startupMs,
    });
    this.watches.set(repo, watch);
    return watch;
  }

  /** The run of the service's task `dev` while its process group is alive (also while it is being stopped). */
  private liveRun(repo: string): RunState | undefined {
    const run = this.deps.mise.run(repo, SERVICE_MISE_TASK);
    return run && run.kind !== "exited" ? run : undefined;
  }

  /** Why `repo` has no service: mise did not list its tasks (`mise_unavailable`) or there is no task `dev` (`not_found`). */
  private async serviceProblem(repo: string): Promise<{ code: "mise_unavailable" | "not_found"; message: string } | null> {
    const tasks = await this.deps.mise.tasks(repo);
    if (tasks.kind !== "ok") return { code: "mise_unavailable", message: `${repo}: ${tasks.message}` };
    if (hasService(tasks.tasks)) return null;
    return { code: "not_found", message: `${repo} has no mise task "${SERVICE_MISE_TASK}", which runs its service` };
  }

  /** `server.port` of the Spring Boot apps on the card; none when the card cannot be built. */
  private async cardPorts(repo: string): Promise<number[]> {
    const result = await this.deps.cards.card(repo).catch(() => null);
    const ports = (result?.card?.provides ?? []).flatMap((p) => (p.kind === "app" && p.port ? [p.port] : []));
    return [...new Set(ports)];
  }

  /** The log cursor right now: every record after it is newer than this moment, in every source. */
  private logCursor(repo: string): number {
    return this.deps.logs.tail({ source: devSource(repo), limit: 1 }).nextSeq;
  }

  /** Whether a slice that is still starting includes `repo`. */
  private wanted(repo: string): boolean {
    return [...this.slices.values()].some((s) => s.status === "running" && s.members.has(repo));
  }

  /** Dependencies the slice (or an earlier start of its root) started that no other slice uses: one still starting or one whose root runs. */
  private ownDependencies(slice: SliceRun): string[] {
    const usedElsewhere = new Set(
      [...this.slices.values()]
        .filter((s) => s !== slice && (s.status === "running" || this.liveRun(s.root)))
        .flatMap((s) => [...s.members].filter(([, m]) => m.outcome !== "skipped").map(([r]) => r)),
    );
    return this.startedDependencies(slice).filter((r) => !usedElsewhere.has(r));
  }

  /** Dependencies the slice and the earlier starts of its root `started`. */
  private startedDependencies(slice: SliceRun): string[] {
    const started = [...slice.members].filter(([r, m]) => r !== slice.root && m.outcome === "started").map(([r]) => r);
    return [...new Set([...started, ...slice.inherited])];
  }

  private sliceView(slice: SliceRun): ServiceSlice {
    const members = [...slice.members].map(([repo, member]): SliceMember => {
      const service = member.outcome === "skipped" || member.outcome === "pending" ? null : (this.watches.get(repo)?.view() ?? null);
      const calledBy = slice.plan?.calledBy.get(repo) ?? [];
      return { repo, calledBy, ...member, service, errors: service ? this.memberErrors(service) : [] };
    });
    const settled = slice.status !== "running" && members.every((m) => m.service?.state !== "starting");
    return { repo: slice.root, members, settled };
  }

  /** Errors of the member's current run. Newest first, so they lead; the filter drops those of an earlier run. */
  private memberErrors(service: Service) {
    if (service.state !== "crashed" && service.state !== "unhealthy") return [];
    const { errors } = this.deps.logs.errors({ repo: service.repo, miseTask: SERVICE_MISE_TASK, minLevel: "error", limit: MEMBER_ERRORS });
    return errors.filter((e) => e.runId === service.run.runId);
  }
}

function skipped(problem: string): Member {
  return { outcome: "skipped", problem };
}

function devSource(repo: string): LogSource {
  return { kind: "mise-task", repo, miseTask: SERVICE_MISE_TASK };
}
