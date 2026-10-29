import {
  type CallEndpointRequest,
  type CallEndpointResult,
  hasService,
  type LogErrors,
  type LogErrorsQuery,
  type LogSource,
  type LogTail,
  type LogTailRequest,
  type MiseTarget,
  type MiseTasks,
  miseTargetKey,
  miseTaskLogSource,
  type RepoCardResult,
  type RepoGraph,
  type RunningMiseTask,
  type RunState,
  SERVICE_MISE_TASK,
  type Service,
  type ServicePortSource,
  type ServiceSlice,
  type SliceMember,
  type StartServiceRequest,
  type StopServiceRequest,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { waitLimited } from "../../infra/wait-limit.ts";
import { callEndpoint } from "./endpoint-call.ts";
import { type Lease, Leases } from "./leases.ts";
import { probePort } from "./port-probe.ts";
import { ServiceWatch, type WatchedRun } from "./service-watch.ts";
import { planSlice, type SlicePlan } from "./slice-plan.ts";

/**
 * Module `services` (§4, §4.3, ADR-45): a service is a repo and its mise task `dev`. A start brings up the slice, the
 * repo and the repos it calls at runtime from the graph, dependencies first, and watches each run until it is ready
 * (its port answers) or has ended. An endpoint call goes only to the port of a running service and returns the
 * response with the errors that appeared in the service logs meanwhile. State lives in memory: the process groups do
 * not outlive the daemon either (§4.1).
 *
 * A service runs from the repo root or from a task's worktree (ADR-61), and a repo can have both at once: `mise`
 * gives a run in a task worktree the task port, which is then the port the task's service is expected on. Only the
 * root of a slice runs from a task worktree; its dependencies run from their repo roots, as the code the task did not
 * change. Services are keyed by that target, never by the repo alone.
 *
 * A task's service can take the repo root's port instead of the task port (a lease, ADR-132): the root's service stops
 * first, the task's runs on its port, and other slices take it as the repo's service. The lease ends when the task's
 * service stops or crashes, and the root's service starts again if the lease stopped it.
 */

/** What `services` needs from `mise`: the task `dev` started from the current list, as the button in the UI does. */
interface ServicesMise {
  tasks(repo: string): Promise<MiseTasks>;
  start(target: MiseTarget, miseTask: string, port?: number): Promise<RunState>;
  stop(target: MiseTarget, miseTask: string): Promise<RunState>;
  run(target: MiseTarget, miseTask: string): RunState | undefined;
  running(): RunningMiseTask[];
}

/** What `services` needs from `logs`: the log of the task `dev` and its errors (ADR-28, ADR-42). */
interface ServicesLogs {
  tail(request: LogTailRequest): LogTail;
  errors(query: LogErrorsQuery): LogErrors;
  mask(text: string, env: NodeJS.ProcessEnv): string;
  runStartCursor(): number;
}

export interface ServicesDeps {
  mise: ServicesMise;
  logs: ServicesLogs;
  graph: { graph(): Promise<RepoGraph> };
  cards: { card(repo: string): Promise<RepoCardResult> };
  /**
   * The port of a task of `repo` (`agents`, ADR-61), which `mise` gives every run in its worktree; a `DomainError`
   * for a task that is not in that repo (never was, or the user ended it).
   */
  taskPort: (repo: string, task: string) => number;
  /** Environment of the processes started for the user; its secret values are masked in responses. */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** The daemon log, for a root's service that does not start again after a lease. */
  log: (line: string) => void;
  /** How often a watch checks a running service (500 ms in the daemon). */
  intervalMs: number;
  /** How long a service may be `starting` before it is `unhealthy` (5 minutes in the daemon: Gradle compiles first). */
  startupMs: number;
  /** How long to keep reading logs after a response, for errors logged after it was sent (500 ms in the daemon). */
  settleMs: number;
  /**
   * How long a stop waits, after the process group has ended, for the service's port to close (`SERVICE_RELEASE_MS`
   * in the daemon): an app a build tool runs outside the group (Gradle's daemon) shuts down after it.
   */
  releaseMs: number;
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
  root: MiseTarget;
  dependencies: boolean;
  status: "running" | "cancelled" | "done";
  /** The plan, once the graph has been read; a refused plan (too many repos) rejects. */
  planned: Promise<SlicePlan>;
  plan: SlicePlan | undefined;
  /** By `miseTargetKey`, in start order. */
  members: Map<string, Member & { target: MiseTarget }>;
  /** Members an earlier start of the same root `started` that this one does not include: a stop with dependencies stops them too. */
  inherited: readonly MiseTarget[];
  done: Promise<void>;
}

export class Services {
  private readonly deps: ServicesDeps;
  /** The watch of the latest run of each service, by `miseTargetKey`, in the order of the first start. */
  private readonly watches = new Map<string, ServiceWatch>();
  /** The latest start of each root, by `miseTargetKey`; `stop` with dependencies stops what it started. */
  private readonly slices = new Map<string, SliceRun>();
  /** Starts in progress per service, so two slices that share a dependency start it once and a stop can wait for them. */
  private readonly starting = new Map<string, Promise<Member>>();
  private readonly leases = new Leases();

  constructor(deps: ServicesDeps) {
    this.deps = deps;
  }

  /**
   * Watched services, with a `dev` started elsewhere (the mise tasks tab, `run_mise_task`) adopted first. The services
   * of a task the user ended are forgotten once they no longer run, so the list does not grow with every task.
   */
  async list(): Promise<Service[]> {
    for (const { repo, task, miseTask } of this.deps.mise.running()) if (miseTask === SERVICE_MISE_TASK) await this.adopt({ repo, task });
    const targets = [...this.watches.values()].map((w) => w.target).concat([...this.slices.values()].map((s) => s.root));
    for (const target of targets) if (this.forgettable(target)) this.forget(miseTargetKey(target));
    return [...this.watches.values()].map((w) => w.view());
  }

  /**
   * Starts the service of `repo` (and with `dependencies` its slice) and waits up to `waitMs` for the slice to settle;
   * the start goes on in the background. A service that already runs is not started again, so calling again waits
   * further; a crashed one starts again. A repo without the mise task `dev` is `not_found`, before anything starts.
   * With `task`, the service runs from that task's worktree (ADR-61) and its dependencies from their repo roots; a
   * task that is not in `repo` is refused before anything starts (`agents.taskOfRepo`). With `lease`, the task's
   * service takes the port of the repo root's service (ADR-132), which stops first; the root's service cannot start
   * while a lease holds its port.
   */
  async start({ repo, task, lease, dependencies, waitMs }: StartServiceRequest): Promise<ServiceSlice> {
    const root: MiseTarget = { repo, task };
    if (task !== null) this.deps.taskPort(repo, task);
    else if (lease) throw new DomainError("bad_request", "only a task's service can take the repo's port: give the task");
    const problem = await this.serviceProblem(repo);
    if (problem) throw new DomainError(problem.code, problem.message);
    const held = this.leases.of(repo);
    if (task === null && held) throw new DomainError("bad_request", leasedPort(held));
    if (task !== null && lease) await (await this.takeLease({ repo, task })).ready;
    // No `await` between the lookup and the registration: two starts at once share one slice.
    let slice = this.slices.get(miseTargetKey(root));
    if (slice?.status === "running" && slice.dependencies !== dependencies) {
      // Replacing it would start the repo before the dependencies of the other plan, or leave them out of a stop's reach.
      const other = dependencies ? "without" : "with";
      throw new DomainError("bad_request", `a start of ${where(root)} ${other} dependencies is in progress: wait for it or stop it first`);
    }
    if (slice?.status !== "running") {
      slice = this.bringUp(root, dependencies, slice);
      this.slices.set(miseTargetKey(root), slice);
    }
    await slice.planned;
    const waited = new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref());
    await Promise.race([slice.done, waited]);
    return this.sliceView(slice);
  }

  /**
   * Stops the service of `repo` and, with `dependencies`, the services its starts started, except the ones
   * another running slice uses. A start in progress is cancelled first: no member starts after that, and members whose
   * start was already under way are stopped once they run. Returns the stopped services; a service whose group has
   * ended while its port still answers is checked again.
   */
  async stop({ repo, task, dependencies }: StopServiceRequest): Promise<Service[]> {
    const root: MiseTarget = { repo, task };
    const slice = this.slices.get(miseTargetKey(root));
    // A root that crashed or was skipped may still have dependencies its start started.
    if (!slice && !this.liveRun(root) && !this.releasing(root))
      throw new DomainError("not_found", `the service of ${where(root)} has not been started`);
    if (slice?.status === "running") slice.status = "cancelled";
    const members = slice ? [...slice.members.keys()] : [miseTargetKey(root)];
    await Promise.all(members.map((key) => this.starting.get(key)));
    const targets = [root, ...(dependencies && slice ? this.ownDependencies(slice) : [])];
    const stopped = await Promise.all(targets.map((t) => this.stopOne(t)));
    return stopped.filter((s) => s !== null);
  }

  /**
   * An HTTP request to the running service of `repo` (ADR-45), with `task` the one from that task's worktree
   * (ADR-61), and the errors that appeared in the logs of the mise task `dev` of every repo root and task worktree
   * from just before the request until `settleMs` after the response.
   */
  async call(request: CallEndpointRequest): Promise<CallEndpointResult> {
    const target: MiseTarget = { repo: request.repo, task: request.task };
    const watch = (await this.adopt(target)) ?? this.watches.get(miseTargetKey(target));
    const view = watch && (await watch.refresh());
    const address = watch?.reachable();
    if (!view || !address) {
      const why = view ? `is ${view.state}${view.reason ? ` (${view.reason})` : ""}` : "has not been started";
      throw new DomainError("service_unavailable", `the service of ${where(target)} ${why}`);
    }
    const cursor = this.logCursor(target);
    const env = await this.deps.env();
    const result = await callEndpoint(address, request, (text) => this.deps.logs.mask(text, env));
    await new Promise((resolve) => setTimeout(resolve, this.deps.settleMs));
    const { errors } = this.deps.logs.errors({
      miseTask: SERVICE_MISE_TASK,
      minLevel: "error",
      sinceSeq: cursor,
      limit: CALL_ERRORS,
    });
    return { ...result, errors };
  }

  private bringUp(root: MiseTarget, dependencies: boolean, previous: SliceRun | undefined): SliceRun {
    const edges = dependencies ? this.deps.graph.graph().then((g) => g.edges) : Promise.resolve([]);
    const slice: SliceRun = {
      root,
      dependencies,
      status: "running",
      planned: edges.then((e) => planSlice(e, root.repo)),
      plan: undefined,
      members: new Map(),
      inherited: previous ? this.startedDependencies(previous) : [],
      done: Promise.resolve(),
    };
    slice.done = slice.planned
      .then(async (plan) => {
        slice.plan = plan;
        const waves = plan.waves.map((wave) => wave.map((repo) => this.memberTarget(slice, repo)));
        for (const target of waves.flat()) slice.members.set(miseTargetKey(target), { target, outcome: "pending", problem: null });
        for (const wave of waves) {
          if (slice.status !== "running") return;
          await Promise.all(wave.map((t) => this.ensure(slice, t)));
        }
      })
      .finally(() => {
        if (slice.status === "running") slice.status = "done";
        // A lease whose service never started (skipped, cancelled, failed) gives the port back at once.
        const lease = this.leases.heldBy(slice.root);
        if (lease?.runId === null && !this.starting.has(miseTargetKey(slice.root))) this.endLease(lease);
        for (const [key, member] of slice.members) {
          if (member.outcome !== "pending") continue;
          slice.members.set(key, { target: member.target, ...skipped("not started: the start was cancelled by a stop or failed") });
        }
      });
    // A refused plan reaches the caller through `planned`; `done` only ends the slice.
    slice.done.catch(() => {});
    return slice;
  }

  /** Brings one member up and resolves once it has settled; its outcome is set as soon as it is known. */
  private async ensure(slice: SliceRun, target: MiseTarget): Promise<void> {
    const key = miseTargetKey(target);
    const running = await this.adopt(target);
    if (running) {
      slice.members.set(key, { target, outcome: "running", problem: null });
      return running.settled();
    }
    let start = this.starting.get(key);
    if (!start) {
      start = this.startOne(slice, target).finally(() => this.starting.delete(key));
      this.starting.set(key, start);
    }
    slice.members.set(key, { target, ...(await start) });
    await this.watches.get(key)?.settled();
  }

  /**
   * Starts one service. Checks mise again even for the root: dependency waves can take minutes, and the config may
   * have changed meanwhile.
   */
  private async startOne(slice: SliceRun, target: MiseTarget): Promise<Member> {
    if (target.task !== null && this.knownTaskPort(target.repo, target.task) === null) return skipped(`task ${target.task} has ended`);
    const problem = await this.serviceProblem(target.repo);
    if (problem) return skipped(problem.message);
    const expected = await this.expectedPorts(target);
    for (const port of expected.ports) if (await probePort(port)) return skipped(this.portTaken(target, port, expected.source));
    const cursor = this.logCursor(target);
    // Right before the start: a stop that came meanwhile wins, unless another running slice still needs the service.
    if (slice.status === "cancelled" && !this.wanted(target)) return skipped("the start was cancelled by a stop");
    const lease = this.leases.heldBy(target);
    try {
      const run = await this.deps.mise.start(target, SERVICE_MISE_TASK, lease?.port);
      // Before the watch: the watch it replaces ends, and that must not end the lease.
      if (lease) lease.runId = run.runId;
      this.watch({ target, run, expectedPorts: expected.ports, expectedSource: expected.source, cursor });
      return { outcome: "started", problem: null };
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      return skipped(`${err.code}: ${err.message}`);
    }
  }

  private async stopOne(target: MiseTarget): Promise<Service | null> {
    const live = await this.adopt(target);
    const watch = live ?? this.releasing(target);
    if (!watch) return null;
    if (live) await this.deps.mise.stop(target, SERVICE_MISE_TASK);
    // The group has ended, but an app a build tool runs outside it (Gradle's daemon) may still hold the port a while.
    if ((await watch.refresh()).state === "stopping") await waitLimited(watch.released(), this.deps.releaseMs);
    return watch.view();
  }

  /** The watch of a service whose stop ended its process group while its port still answers (§4.3). */
  private releasing(target: MiseTarget): ServiceWatch | undefined {
    const watch = this.watches.get(miseTargetKey(target));
    return watch && !this.liveRun(target) && watch.view().state === "stopping" ? watch : undefined;
  }

  /** Why a port that answers before the start is not this service's. */
  private portTaken(target: MiseTarget, port: number, source: ServicePortSource): string {
    const what = { card: "server.port on the card", task: "the task port", lease: `the port of ${target.repo}`, log: "from the log" }[
      source
    ];
    const holders = [...this.watches.values()].filter((w) => w.view().port === port);
    const running = holders.find((w) => this.liveRun(w.target));
    if (running) return `port ${port} (${what}) is used by the service of ${where(running.target)}`;
    const stopping = holders.find((w) => this.releasing(w.target) === w);
    if (stopping) return `port ${port} (${what}) still answers after the stop of the service of ${where(stopping.target)}`;
    return `port ${port} (${what}) is already in use by a program Trackwall did not start`;
  }

  /**
   * The watch of the service's live run, also for a `dev` started elsewhere, which gets a watch here reading its log
   * from the oldest buffered record; `undefined` when the task does not run.
   */
  private async adopt(target: MiseTarget): Promise<ServiceWatch | undefined> {
    const run = this.liveRun(target);
    if (!run) return undefined;
    const current = this.watches.get(miseTargetKey(target));
    if (current?.runId === run.runId) return current;
    const expected = await this.expectedPorts(target);
    const cursor = this.deps.logs.runStartCursor();
    return this.watch({ target, run, expectedPorts: expected.ports, expectedSource: expected.source, cursor });
  }

  /** The watch of a run, made once; it replaces the watch of an older run of the same service. */
  private watch(watched: WatchedRun): ServiceWatch {
    const { target, run } = watched;
    const key = miseTargetKey(target);
    const current = this.watches.get(key);
    if (current?.runId === run.runId) return current;
    current?.dispose();
    const source = devSource(target);
    const watch = new ServiceWatch(watched, {
      run: () => this.deps.mise.run(target, SERVICE_MISE_TASK),
      tail: (page) => this.deps.logs.tail({ source, ...page }),
      probe: probePort,
      intervalMs: this.deps.intervalMs,
      startupMs: this.deps.startupMs,
    });
    this.watches.set(key, watch);
    const lease = this.leases.heldBy(target);
    if (lease?.runId === run.runId) void watch.finished().then(() => this.runEnded(lease, run.runId));
    return watch;
  }

  /**
   * The lease `target` takes on the port of its repo root's service (ADR-132), or the one it holds already. The root's
   * service is stopped (its start in progress refuses), and the lease is ready once it has; another task's lease and the
   * task's own service on the task port refuse, so nothing stops without the caller knowing.
   */
  private async takeLease(holder: MiseTarget & { task: string }): Promise<Lease> {
    const root: MiseTarget = { repo: holder.repo, task: null };
    const port = await this.rootPort(holder.repo);
    // No `await` from here to `add`: two starts at once take one lease.
    const held = this.leases.of(holder.repo);
    if (held?.holder.task === holder.task) return held;
    if (held) throw new DomainError("bad_request", leasedPort(held));
    if (this.liveRun(holder) || this.starting.has(miseTargetKey(holder)))
      throw new DomainError(
        "bad_request",
        `the service of ${where(holder)} runs on the task port: stop it first, then start it on the port of ${holder.repo}`,
      );
    if (this.slices.get(miseTargetKey(root))?.status === "running")
      throw new DomainError("bad_request", `a start of ${holder.repo} is in progress: wait for it or stop it first`);
    const restoreRoot = this.liveRun(root) !== undefined;
    const lease: Lease = { holder, port, runId: null, restoreRoot, ready: Promise.resolve() };
    this.leases.add(lease);
    // A stop that fails (a group that cannot be killed) leaves the root as it is, so the lease ends unused.
    if (restoreRoot)
      lease.ready = this.stopOne(root).then(
        () => {},
        (err: unknown) => {
          this.leases.remove(lease);
          throw err;
        },
      );
    return lease;
  }

  /**
   * The port of the repo root's service: the one its running service uses, otherwise the only `server.port` on its card.
   * Several apps on the card are refused, since the lease could take the wrong one.
   */
  private async rootPort(repo: string): Promise<number> {
    const running = (await this.adopt({ repo, task: null }))?.view().port;
    if (running) return running;
    const { ports } = await this.expectedPorts({ repo, task: null });
    const [port, ...more] = ports;
    if (port !== undefined && more.length === 0) return port;
    const why =
      port === undefined
        ? "no server.port on its card and its service is not running"
        : `its card has several apps with server.port (${ports.join(", ")}); start the repo's service first, so its port is known`;
    throw new DomainError("bad_request", `${repo} has no single port a task's service could take: ${why}`);
  }

  /** The holder's run on the leased port has ended (stopped, crashed, gone): the lease ends unless a new run took over. */
  private runEnded(lease: Lease, runId: string): void {
    if (lease.runId === runId && !this.liveRun(lease.holder)) this.endLease(lease);
  }

  /** Gives the port back: the root's service starts again (without dependencies, which kept running) if the lease stopped it. */
  private endLease(lease: Lease): void {
    if (!this.leases.remove(lease) || !lease.restoreRoot) return;
    const { repo } = lease.holder;
    this.start({ repo, task: null, lease: false, dependencies: false, waitMs: 0 }).catch((err: unknown) =>
      this.deps.log(`the service of ${repo} did not start again after the lease of task ${lease.holder.task} ended: ${messageOf(err)}`),
    );
  }

  /** The run of the service's task `dev` while its process group is alive (also while it is being stopped). */
  private liveRun(target: MiseTarget): RunState | undefined {
    const run = this.deps.mise.run(target, SERVICE_MISE_TASK);
    return run && run.kind !== "exited" ? run : undefined;
  }

  /** The service of a task the user ended (ADR-61) once it neither runs nor starts: nothing can start it again. */
  private forgettable(target: MiseTarget): boolean {
    const key = miseTargetKey(target);
    if (target.task === null || this.liveRun(target) || this.starting.has(key) || this.wanted(target)) return false;
    // The slice is the only record of the dependencies it started: kept while one of them runs, so a stop can reach them.
    const slice = this.slices.get(key);
    if (slice && this.startedDependencies(slice).some((t) => this.liveRun(t))) return false;
    return this.knownTaskPort(target.repo, target.task) === null;
  }

  /** The port of a task of `repo`, `null` once the task has ended. */
  private knownTaskPort(repo: string, task: string): number | null {
    try {
      return this.deps.taskPort(repo, task);
    } catch (err) {
      if (err instanceof DomainError) return null;
      throw err;
    }
  }

  private forget(key: string): void {
    this.watches.get(key)?.dispose();
    this.watches.delete(key);
    this.slices.delete(key);
  }

  /**
   * Why `repo` has no service: mise did not list its tasks (`mise_unavailable`) or there is no task `dev` (`not_found`).
   * A task's service is checked against the repo root's list too, as the code the task started from; `mise` refuses a
   * start in a worktree whose `dev` the task removed.
   */
  private async serviceProblem(repo: string): Promise<{ code: "mise_unavailable" | "not_found"; message: string } | null> {
    const tasks = await this.deps.mise.tasks(repo);
    if (tasks.kind !== "ok") return { code: "mise_unavailable", message: `${repo}: ${tasks.message}` };
    if (hasService(tasks.tasks)) return null;
    return { code: "not_found", message: `${repo} has no mise task "${SERVICE_MISE_TASK}", which runs its service` };
  }

  /**
   * The ports the service is expected on until its log names one: the leased port for a task's service on a lease
   * (ADR-132), the task port for another task's service (ADR-61), otherwise `server.port` of the Spring Boot apps on the
   * card (none when the card cannot be built).
   */
  private async expectedPorts(target: MiseTarget): Promise<{ ports: number[]; source: ServicePortSource }> {
    const lease = this.leases.heldBy(target);
    if (lease) return { ports: [lease.port], source: "lease" };
    if (target.task !== null) {
      const port = this.knownTaskPort(target.repo, target.task);
      return { ports: port === null ? [] : [port], source: "task" };
    }
    const result = await this.deps.cards.card(target.repo).catch(() => null);
    const ports = (result?.card?.provides ?? []).flatMap((p) => (p.kind === "app" && p.port ? [p.port] : []));
    return { ports: [...new Set(ports)], source: "card" };
  }

  /** The log cursor right now: every record after it is newer than this moment, in every source. */
  private logCursor(target: MiseTarget): number {
    return this.deps.logs.tail({ source: devSource(target), limit: 1 }).nextSeq;
  }

  /** Whether a slice that is still starting includes `target`. */
  private wanted(target: MiseTarget): boolean {
    return [...this.slices.values()].some((s) => s.status === "running" && s.members.has(miseTargetKey(target)));
  }

  /** Dependencies the slice (or an earlier start of its root) started that no other slice uses: one still starting or one whose root runs. */
  private ownDependencies(slice: SliceRun): MiseTarget[] {
    const usedElsewhere = new Set(
      [...this.slices.values()]
        .filter((s) => s !== slice && (s.status === "running" || this.liveRun(s.root)))
        .flatMap((s) => [...s.members].filter(([, m]) => m.outcome !== "skipped").map(([key]) => key)),
    );
    return this.startedDependencies(slice).filter((t) => !usedElsewhere.has(miseTargetKey(t)));
  }

  /** Dependencies the slice and the earlier starts of its root `started`. */
  private startedDependencies(slice: SliceRun): MiseTarget[] {
    const rootKey = miseTargetKey(slice.root);
    const started = [...slice.members].filter(([key, m]) => key !== rootKey && m.outcome === "started").map(([, m]) => m.target);
    const unique = new Map([...started, ...slice.inherited].map((t) => [miseTargetKey(t), t]));
    return [...unique.values()];
  }

  /**
   * The slice's own repo runs where the slice was asked for; every dependency from its repo root, or from the task
   * whose service holds the root's port (ADR-132), which callers then reach.
   */
  private memberTarget(slice: SliceRun, repo: string): MiseTarget {
    if (repo === slice.root.repo) return slice.root;
    return this.leases.of(repo)?.holder ?? { repo, task: null };
  }

  private sliceView(slice: SliceRun): ServiceSlice {
    const members = [...slice.members].map(([key, { target, ...member }]): SliceMember => {
      const service = member.outcome === "skipped" || member.outcome === "pending" ? null : (this.watches.get(key)?.view() ?? null);
      const calledBy = slice.plan?.calledBy.get(target.repo) ?? [];
      return { ...target, calledBy, ...member, service, errors: service ? this.memberErrors(service) : [] };
    });
    const settled = slice.status !== "running" && members.every((m) => m.service?.state !== "starting");
    return { ...slice.root, members, settled };
  }

  /** Errors of the member's current run. Newest first, so they lead; the filter drops those of an earlier run. */
  private memberErrors(service: Service) {
    if (service.state !== "crashed" && service.state !== "unhealthy") return [];
    const { errors } = this.deps.logs.errors({
      repo: service.repo,
      task: service.task,
      miseTask: SERVICE_MISE_TASK,
      minLevel: "error",
      limit: MEMBER_ERRORS,
    });
    return errors.filter((e) => e.runId === service.run.runId);
  }
}

function skipped(problem: string): Member {
  return { outcome: "skipped", problem };
}

function devSource({ repo, task }: MiseTarget): LogSource {
  return miseTaskLogSource(repo, task, SERVICE_MISE_TASK);
}

/** Why the root's service cannot start: a task's service holds its port. */
function leasedPort({ holder, port }: Lease): string {
  return `port ${port} of ${holder.repo} is leased to the service of task ${holder.task}: stop that service, which gives the port back`;
}

/** The service's place in a message: the repo, or the task worktree in it. */
function where({ repo, task }: MiseTarget): string {
  return task === null ? repo : `task ${task} in ${repo}`;
}
