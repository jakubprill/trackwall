import {
  LOG_TAIL_MAX,
  type LogTail,
  type LogTailRequest,
  type RunState,
  type Service,
  type ServicePortSource,
  type ServiceState,
} from "@trackwall/protocol";
import type { LoopbackHost } from "./port-probe.ts";
import { isStartedLine, portFromLine } from "./readiness.ts";

/**
 * Observed state of one run of a service (§4.3, ADR-45), checked in a loop until the process group has ended: the run
 * state from `procs` (through `mise`), new lines of its log (the port, Spring Boot's "Started") and a TCP probe of the
 * port. Nothing is assumed: `healthy` only after the port accepted a connection, `crashed` only after the system
 * confirmed the group ended by itself.
 */

export interface WatchDeps {
  /** The current run of the service's mise task, `undefined` when it has never run. */
  run(): RunState | undefined;
  tail(request: Pick<LogTailRequest, "sinceSeq" | "limit">): LogTail;
  probe(port: number): Promise<LoopbackHost | null>;
  /** How often to check while the service runs. */
  intervalMs: number;
  /** How long `starting` may last before the service is `unhealthy`. */
  startupMs: number;
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
  /** Ports from `server.port` on the card, used until the log names one. */
  private readonly cardPorts: readonly number[];
  private state: ServiceState = "starting";
  private since = new Date().toISOString();
  private reason: string | null = "waiting for the port to answer";
  private logPort: number | null = null;
  private started = false;
  private address: ServiceAddress | null = null;
  private cursor: number | undefined;
  private lastRun: RunState;
  private readonly startedAt = Date.now();
  private readonly waiters: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(repo: string, run: RunState, cardPorts: readonly number[], cursor: number | undefined, deps: WatchDeps) {
    this.repo = repo;
    this.runId = run.runId;
    this.lastRun = run;
    this.cardPorts = cardPorts;
    this.cursor = cursor;
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

  /** Checks now instead of at the next tick, e.g. right after a stop or before an endpoint call. */
  async refresh(): Promise<Service> {
    if (!this.stopped) await this.check();
    return this.view();
  }

  /** Stops checking; the run was replaced by a newer one with its own watch. */
  dispose(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.settle();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.check().finally(() => this.schedule(this.deps.intervalMs)), delayMs);
    // A watch does not keep the daemon alive; the process group it watches is stopped on exit anyway.
    this.timer.unref();
  }

  private async check(): Promise<void> {
    const run = this.deps.run();
    if (!run || run.runId !== this.runId) return this.dispose();
    this.lastRun = run;
    if (run.kind === "exited") return this.end(run);
    if (run.kind === "stopping") return this.set("stopping", null);
    this.readLog();
    await this.probe();
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

  private async probe(): Promise<void> {
    const ports = this.logPort !== null ? [this.logPort] : this.cardPorts;
    for (const port of ports) {
      const host = await this.deps.probe(port);
      if (host) {
        this.address = { host, port };
        return this.set("healthy", null);
      }
    }
    this.address = null;
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
