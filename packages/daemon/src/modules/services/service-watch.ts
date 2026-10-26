import {
  type ExitedRun,
  LOG_TAIL_MAX,
  type LogTail,
  type LogTailRequest,
  type MiseTarget,
  type RunState,
  type Service,
  type ServicePortSource,
  type ServiceState,
} from "@trackwall/protocol";
import type { LoopbackHost } from "../../infra/loopback.ts";
import { isStartedLine, portFromLine } from "./readiness.ts";

/**
 * Observed state of one run of a service (§4.3, ADR-45), checked in a loop until the process group has ended: the run
 * state from `procs` (through `mise`), new lines of its log (the port, Spring Boot's "Started") and a TCP probe of the
 * port. Nothing is assumed: `healthy` only after the port accepted a connection, `crashed` only after the system
 * confirmed the group ended by itself, `stopped` only after a stop emptied the group and the port no longer answers. A
 * build tool may run the app outside the group (Gradle's daemon runs `bootRun`'s app as its own child), so the app can
 * outlive the group for a moment or for good: until its port closes the service stays `stopping`. One check runs at a
 * time, and nothing changes the state after the end.
 */

export interface WatchDeps {
  /** The current run of the service's mise task, `undefined` when it has never run. */
  run(): RunState | undefined;
  tail(request: Pick<LogTailRequest, "sinceSeq" | "limit">): LogTail;
  probe(port: number): Promise<LoopbackHost | null>;
  /** How often to check while the service runs. */
  intervalMs: number;
  /** How long `starting` may last, from the start of the run, before the service is `unhealthy`. */
  startupMs: number;
}

export interface WatchedRun {
  /** Where the service runs: the repo root (`task: null`) or a task's worktree (ADR-61). */
  target: MiseTarget;
  run: RunState;
  /** Ports from `server.port` on the card, or the task port, used until the log names one. */
  expectedPorts: readonly number[];
  /** Log cursor from which the run's records are read: taken before the start, or the start of the daemon run. */
  cursor: number;
}

/** A reachable port of the service and the loopback address that answered on it. */
export interface ServiceAddress {
  host: LoopbackHost;
  port: number;
}

export class ServiceWatch {
  readonly target: WatchedRun["target"];
  readonly runId: string;
  private readonly deps: WatchDeps;
  private readonly expectedPorts: readonly number[];
  private readonly startedAt: number;
  private lastRun: RunState;
  private cursor: number;
  private state: ServiceState = "starting";
  private since = new Date().toISOString();
  private reason: string | null = "waiting for the port to answer";
  private logPort: number | null = null;
  private started = false;
  private address: ServiceAddress | null = null;
  private readonly waiters: { done: (state: ServiceState) => boolean; resolve: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private ended = false;

  constructor(watched: WatchedRun, deps: WatchDeps) {
    this.target = watched.target;
    this.runId = watched.run.runId;
    this.lastRun = watched.run;
    this.startedAt = Date.parse(watched.run.startedAt);
    this.expectedPorts = watched.expectedPorts;
    this.cursor = watched.cursor;
    this.deps = deps;
    this.schedule(0);
  }

  view(): Service {
    const port = this.address?.port ?? this.logPort ?? this.expectedPorts[0] ?? null;
    const expected: ServicePortSource = this.target.task === null ? "card" : "task";
    const portSource: ServicePortSource | null = port === null ? null : this.logPort === port ? "log" : expected;
    return { ...this.target, state: this.state, port, portSource, run: this.lastRun, since: this.since, reason: this.reason };
  }

  /** Where to send a request: the port that answered the last probe; `null` unless `healthy`. */
  reachable(): ServiceAddress | null {
    return this.state === "healthy" ? this.address : null;
  }

  /** Resolves once the service is no longer `starting`. */
  settled(): Promise<void> {
    return this.until((state) => state !== "starting");
  }

  /** Resolves once the service is no longer `stopping`: after a stop, once the group has ended and the port closed. */
  released(): Promise<void> {
    return this.until((state) => state !== "stopping");
  }

  /** Checks now instead of at the next tick (right after a stop, before an endpoint call); joins a check in flight. */
  async refresh(): Promise<Service> {
    // A check in flight may have read the run before the change the caller waits for (a stop), so one more follows.
    await this.inFlight;
    await this.check();
    return this.view();
  }

  /** Stops checking: the run ended or a newer run of the service has its own watch. */
  dispose(): void {
    this.ended = true;
    clearTimeout(this.timer);
    this.settle();
  }

  private schedule(delayMs: number): void {
    if (this.ended) return;
    this.timer = setTimeout(() => void this.check().finally(() => this.schedule(this.deps.intervalMs)), delayMs);
    // A watch does not keep the daemon alive; the process group it watches is stopped on exit anyway.
    this.timer.unref();
  }

  private check(): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.inFlight ??= this.observe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async observe(): Promise<void> {
    if (!(await this.follow())) return;
    this.readLog();
    const outcome = await this.probe();
    // The run may have changed during the probe; then its new state wins over a port that answered just before.
    if (await this.follow()) this.apply(outcome);
  }

  /** Takes the current run: `true` while it is running, otherwise its end, `stopping` or a replaced run is applied. */
  private async follow(): Promise<boolean> {
    const run = this.deps.run();
    if (this.ended || !run || run.runId !== this.runId) {
      this.dispose();
      return false;
    }
    this.lastRun = run;
    if (run.kind === "exited") await this.end(run);
    else if (run.kind === "stopping") this.set("stopping", null);
    return run.kind === "running";
  }

  /** The run's group has ended: `crashed`, or after a stop `stopped` once nothing answers on the service's port. */
  private async end(run: ExitedRun): Promise<void> {
    this.address = null;
    if (!run.stoppedByUser) {
      this.set("crashed", `the process exited ${run.signal ? `on signal ${run.signal}` : `with code ${run.exitCode}`}`);
      return this.dispose();
    }
    const outcome = await this.probe();
    if (this.ended) return;
    if ("port" in outcome) {
      // Checked again at every tick until the port closes; a new start of the service replaces this watch.
      const holder = "a process outside the service's process group holds it, for example an app Gradle's daemon runs";
      return this.set("stopping", `the process group has ended, but port ${outcome.port} still answers: ${holder}`);
    }
    this.set("stopped", null);
    this.dispose();
  }

  private readLog(): void {
    for (;;) {
      const page = this.deps.tail({ sinceSeq: this.cursor, limit: LOG_TAIL_MAX });
      for (const record of page.records) {
        if (record.runId !== this.runId) continue;
        this.logPort ??= portFromLine(record.msg);
        this.started ||= isStartedLine(record.msg);
      }
      const more = page.records.length === LOG_TAIL_MAX && page.nextSeq !== this.cursor;
      this.cursor = page.nextSeq;
      if (!more) return;
    }
  }

  /** The address that answered, or the ports that were tried without an answer. */
  private async probe(): Promise<ServiceAddress | { tried: readonly number[] }> {
    const ports = this.logPort !== null ? [this.logPort] : this.expectedPorts;
    for (const port of ports) {
      const host = await this.deps.probe(port);
      if (host) return { host, port };
    }
    return { tried: ports };
  }

  private apply(outcome: ServiceAddress | { tried: readonly number[] }) {
    if ("port" in outcome) {
      this.address = outcome;
      return this.set("healthy", null);
    }
    this.address = null;
    const ports = outcome.tried;
    // A Spring Boot app without a web server (a worker) has no port to probe; its "Started" line is the readiness.
    if (ports.length === 0 && this.started) return this.set("healthy", null);
    if (this.state === "healthy") return this.set("unhealthy", `port ${ports.join(", ")} stopped answering`);
    if (this.state === "starting" && Date.now() - this.startedAt > this.deps.startupMs) {
      const what = ports.length > 0 ? `port ${ports.join(", ")} did not answer` : "no port in the log or on the card";
      this.set("unhealthy", `${what} within ${Math.round(this.deps.startupMs / 1000)} s of the start`);
    }
  }

  private set(state: ServiceState, reason: string | null): void {
    if (state !== this.state) this.since = new Date().toISOString();
    this.state = state;
    this.reason = reason;
    this.settle();
  }

  /** Resolves the waits whose state has come, and every wait once the watch has ended. */
  private settle(): void {
    for (const waiter of [...this.waiters]) {
      if (!this.ended && !waiter.done(this.state)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  private until(done: (state: ServiceState) => boolean): Promise<void> {
    if (this.ended || done(this.state)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ done, resolve }));
  }
}
