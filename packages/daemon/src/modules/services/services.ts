import {
  type CallEndpointRequest,
  type CallEndpointResult,
  type LogErrors,
  type LogErrorsRequest,
  type LogSource,
  type LogTail,
  type LogTailRequest,
  type MiseTasks,
  type RepoCardResult,
  type RepoGraph,
  type RunState,
  SERVICE_MISE_TASK,
  type Service,
  type ServiceSlice,
  type SliceMember,
  type StartServiceRequest,
  type StopServiceRequest,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { addressUrl, callEndpoint } from "./endpoint-call.ts";
import { probePort } from "./port-probe.ts";
import { ServiceWatch } from "./service-watch.ts";
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
}

/** What `services` needs from `logs`: the log of the task `dev` and its errors (ADR-28, ADR-42). */
interface ServicesLogs {
  tail(request: LogTailRequest): LogTail;
  errors(request: LogErrorsRequest): LogErrors;
  mask(text: string, env: NodeJS.ProcessEnv): string;
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

/** One start of a slice: its plan and how far it got. */
interface SliceRun {
  root: string;
  dependencies: boolean;
  plan: SlicePlan;
  members: Map<string, Member>;
  done: Promise<void>;
  finished: boolean;
  /** A stop of the root cancels the waves that have not started yet. */
  cancelled: boolean;
}

export class Services {
  private readonly deps: ServicesDeps;
  /** The watch of the latest run of each repo's service, in the order of the first start. */
  private readonly watches = new Map<string, ServiceWatch>();
  /** The latest start of each root repo; `stop` with dependencies stops what it started. */
  private readonly slices = new Map<string, SliceRun>();
  /** Starts in progress per repo, so two slices that share a dependency start it once. */
  private readonly starting = new Map<string, Promise<Member>>();

  constructor(deps: ServicesDeps) {
    this.deps = deps;
  }

  list(): Service[] {
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
    let slice = this.slices.get(repo);
    if (!slice || slice.finished || slice.dependencies !== dependencies) {
      const plan = dependencies
        ? planSlice((await this.deps.graph.graph()).edges, repo)
        : { waves: [[repo]], calledBy: new Map([[repo, []]]) };
      slice = this.bringUp(repo, dependencies, plan);
      this.slices.set(repo, slice);
    }
    const waited = new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref());
    await Promise.race([slice.done, waited]);
    return this.sliceView(slice);
  }

  /**
   * Stops the service of `repo` and, with `dependencies`, the services its latest start started, except the ones
   * another running slice uses. Returns the stopped services; a repo whose service never ran is left out.
   */
  async stop({ repo, dependencies }: StopServiceRequest): Promise<Service[]> {
    const slice = this.slices.get(repo);
    if (slice) slice.cancelled = true;
    const repos = [repo, ...(dependencies && slice ? this.ownDependencies(slice) : [])];
    if (!this.watches.has(repo) && !this.deps.mise.run(repo, SERVICE_MISE_TASK)) {
      throw new DomainError("not_found", `the service of ${repo} has not been started`);
    }
    const stopped: Service[] = [];
    for (const r of repos) {
      if (!this.deps.mise.run(r, SERVICE_MISE_TASK)) continue;
      await this.deps.mise.stop(r, SERVICE_MISE_TASK);
      const watch = this.watches.get(r);
      if (watch) stopped.push(await watch.refresh());
    }
    return stopped;
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
    const began = Date.now();
    const outcome = await callEndpoint(address, request, (text) => this.deps.logs.mask(text, env));
    const durationMs = Date.now() - began;
    await new Promise((resolve) => setTimeout(resolve, this.deps.settleMs));
    const { errors } = this.deps.logs.errors({ miseTask: SERVICE_MISE_TASK, minLevel: "error", sinceSeq: cursor, limit: CALL_ERRORS });
    return {
      url: addressUrl(address, request.path),
      method: request.method,
      response: outcome.kind === "response" ? outcome.response : null,
      failure: outcome.kind === "failure" ? outcome.message : null,
      durationMs,
      errors,
    };
  }

  private bringUp(root: string, dependencies: boolean, plan: SlicePlan): SliceRun {
    const members = new Map<string, Member>(plan.waves.flat().map((r) => [r, { outcome: "pending", problem: null }]));
    const slice: SliceRun = { root, dependencies, plan, members, done: Promise.resolve(), finished: false, cancelled: false };
    slice.done = (async () => {
      for (const wave of plan.waves) {
        if (slice.cancelled) return;
        await Promise.all(wave.map((r) => this.ensure(r, (member) => members.set(r, member))));
      }
    })().finally(() => {
      slice.finished = true;
    });
    return slice;
  }

  /**
   * Brings one service up for a slice and resolves once it has settled. `report` gets the outcome as soon as it is
   * known, so a slice answered while the service is still starting already says `started`.
   */
  private async ensure(repo: string, report: (member: Member) => void): Promise<void> {
    const running = await this.adopt(repo);
    if (running) {
      report({ outcome: "running", problem: null });
      return running.settled();
    }
    let start = this.starting.get(repo);
    if (!start) {
      start = this.startOne(repo).finally(() => this.starting.delete(repo));
      this.starting.set(repo, start);
    }
    report(await start);
    await this.watches.get(repo)?.settled();
  }

  private async startOne(repo: string): Promise<Member> {
    const problem = await this.serviceProblem(repo);
    if (problem) return skipped(problem.message);
    const ports = await this.cardPorts(repo);
    for (const port of ports) {
      if (await probePort(port))
        return skipped(`port ${port} (server.port on the card) is already taken by a process Trackwall did not start`);
    }
    const cursor = this.logCursor(repo);
    try {
      this.watch(repo, await this.deps.mise.start(repo, SERVICE_MISE_TASK), ports, cursor);
      return { outcome: "started", problem: null };
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      return skipped(`${err.code}: ${err.message}`);
    }
  }

  /**
   * The watch of the service's live run, also for a `dev` started elsewhere (the mise tasks tab, `run_mise_task`), which
   * gets a watch here; `undefined` when the task does not run.
   */
  private async adopt(repo: string): Promise<ServiceWatch | undefined> {
    const run = this.deps.mise.run(repo, SERVICE_MISE_TASK);
    const current = this.watches.get(repo);
    if (!run || run.kind === "exited") return undefined;
    if (current?.runId === run.runId) return current;
    return this.watch(repo, run, await this.cardPorts(repo), undefined);
  }

  private watch(repo: string, run: RunState, cardPorts: readonly number[], cursor: number | undefined): ServiceWatch {
    const current = this.watches.get(repo);
    if (current?.runId === run.runId) return current;
    current?.dispose();
    const source = devSource(repo);
    const watch = new ServiceWatch(repo, run, cardPorts, cursor, {
      run: () => this.deps.mise.run(repo, SERVICE_MISE_TASK),
      tail: (page) => this.deps.logs.tail({ source, ...page }),
      probe: probePort,
      intervalMs: this.deps.intervalMs,
      startupMs: this.deps.startupMs,
    });
    // Re-inserted, so the list keeps the order of the first start only for repos that did not start again.
    this.watches.delete(repo);
    this.watches.set(repo, watch);
    return watch;
  }

  /** Why `repo` has no service: mise did not list its tasks (`mise_unavailable`) or there is no task `dev` (`not_found`). */
  private async serviceProblem(repo: string): Promise<{ code: "mise_unavailable" | "not_found"; message: string } | null> {
    const tasks = await this.deps.mise.tasks(repo);
    if (tasks.kind !== "ok") return { code: "mise_unavailable", message: `${repo}: ${tasks.message}` };
    if (tasks.tasks.some((t) => t.name === SERVICE_MISE_TASK)) return null;
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

  /** Members the slice started that no other live slice uses. */
  private ownDependencies(slice: SliceRun): string[] {
    const usedElsewhere = new Set(
      [...this.slices.values()]
        .filter((s) => s !== slice && this.isLive(s.root))
        .flatMap((s) => [...s.members].filter(([, m]) => m.outcome !== "skipped").map(([r]) => r)),
    );
    return [...slice.members].filter(([r, m]) => r !== slice.root && m.outcome === "started" && !usedElsewhere.has(r)).map(([r]) => r);
  }

  private isLive(repo: string): boolean {
    const run = this.deps.mise.run(repo, SERVICE_MISE_TASK);
    return run !== undefined && run.kind !== "exited";
  }

  private sliceView(slice: SliceRun): ServiceSlice {
    const members = slice.plan.waves.flat().map((repo): SliceMember => {
      const member = slice.members.get(repo) ?? { outcome: "pending", problem: null };
      const service = member.outcome === "skipped" || member.outcome === "pending" ? null : (this.watches.get(repo)?.view() ?? null);
      return { repo, calledBy: slice.plan.calledBy.get(repo) ?? [], ...member, service, errors: service ? this.memberErrors(service) : [] };
    });
    const settled = slice.finished && members.every((m) => m.service?.state !== "starting");
    return { repo: slice.root, members, settled };
  }

  private memberErrors(service: Service) {
    if (service.state !== "crashed" && service.state !== "unhealthy") return [];
    const { errors } = this.deps.logs.errors({ repo: service.repo, miseTask: SERVICE_MISE_TASK, minLevel: "error", limit: 20 });
    return errors.filter((e) => e.runId === service.run.runId).slice(0, MEMBER_ERRORS);
  }
}

function skipped(problem: string): Member {
  return { outcome: "skipped", problem };
}

function devSource(repo: string): LogSource {
  return { kind: "mise-task", repo, miseTask: SERVICE_MISE_TASK };
}
