import {
  LOG_TAIL_MAX,
  type LogTail,
  type LogTailRequest,
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
 * confirmed the group ended by itself. One check runs at a time, and nothing changes the state after the end.
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
  repo: string;
  run: RunState;
  /** Ports from `server.port` on the card, used until the log names one. */
  cardPorts: readonly number[];
  /** Log cursor from which the run's records are read: taken before the start, or the start of the daemon run. */
  cursor: number;
}

/** A reachable port of the service and the loopback address that answered on it. */
export interface ServiceAddress {
  host: LoopbackHost;
  port: number;
}

export class ServiceWatch {
  readonly repo: string;
  readonly runId: string;
  private readonly deps: WatchDeps;
  private readonly cardPorts: readonly number[];
  private readonly startedAt: number;
  private lastRun: RunState;
  private cursor: number;
  private state: ServiceState = "starting";
  private since = new Date().toISOString();
  private reason: string | null = "waiting for the port to answer";
  private logPort: number | null = null;
  private started = false;
  private address: ServiceAddress | null = null;
  private readonly waiters: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private ended = false;

  constructor(watched: WatchedRun, deps: WatchDeps) {
    this.repo = watched.repo;
    this.runId = watched.run.runId;
    this.lastRun = watched.run;
    this.startedAt = Date.parse(watched.run.startedAt);
    this.cardPorts = watched.cardPorts;
    this.cursor = watched.cursor;
    this.deps = deps;
    this.schedule(0);
  }

  view(): Service {
    const port = this.address?.port ?? this.logPort ?? this.cardPorts[0] ?? null;
    const portSource: ServicePortSource | null = port === null ? null : this.logPort === port ? "log" : "card";
    return { repo: this.repo, state: this.state, port, portSource, run: this.lastRun, since: this.since, reason: this.reason };
  }

  /** Where to send a request: the port that answered the last probe; `null` unless `healthy`. */
  reachable(): ServiceAddress | null {
    return this.state === "healthy" ? this.address : null;
  }

  /** Resolves once the service is no longer `starting`. */
  settled(): Promise<void> {
    if (this.state !== "starting") return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Checks now instead of at the next tick (right after a stop, before an endpoint call); joins a check in flight. */
  async refresh(): Promise<Service> {
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
    const run = this.deps.run();
    if (!run || run.runId !== this.runId) return this.dispose();
    this.lastRun = run;
    if (run.kind === "exited") return this.end(run);
    if (run.kind === "stopping") return this.set("stopping", null);
    this.readLog();
    const outcome = await this.probe();
    // The run may have ended during the probe; its end is the state then, not a port that answered just before.
    if (this.deps.run()?.kind === "running") this.apply(outcome);
  }

  private end(run: Extract<RunState, { kind: "exited" }>): void {
    if (run.stoppedByUser) this.set("stopped", null);
    else this.set("crashed", `the process exited ${run.signal ? `on signal ${run.signal}` : `with code ${run.exitCode}`}`);
    this.address = null;
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
    const ports = this.logPort !== null ? [this.logPort] : this.cardPorts;
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
    if (state !== "starting") this.settle();
  }

  private settle(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
