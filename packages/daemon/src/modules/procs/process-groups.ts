import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { LogSource, LogStream, RunState } from "@trackwall/protocol";
import { DomainError, SpawnFailure, spawnFailure } from "../../infra/errors.ts";
import { isInside } from "../../infra/path-inside.ts";
import { type GroupControl, type GroupLeader, type GroupPlatform, waitUntil } from "../../platform/process-group.ts";
import type { TerminalPlatform, TerminalProcess } from "../../platform/terminal.ts";
import type { RuntimeFile, RuntimeGroup } from "./runtime-file.ts";

/**
 * The `procs` module (§4.1, ADR-20): every process starts as a process group and ends as a group. State is
 * observed: a run is `exited` only once the system has confirmed that no process of the group is alive.
 * A leader that ended by itself takes the rest of the group with it, so nothing stays in the background unsupervised.
 *
 * The owner (`owner`) is the caller's key, e.g. a mise task in a repo; an owner has one live group,
 * and after it ends its last state stays until the next start.
 */

/**
 * How long to wait for the end of a group after killing it; longer means a process the system cannot end. The grace period
 * (5 s on POSIX) plus this limit fit in the 10 s the Tauri shell waits for the daemon to stop (§5.4).
 */
const KILL_WAIT_MS = 3000;

export interface GroupSpec {
  owner: string;
  /** The program and arguments, without a shell. */
  command: readonly string[];
  /** The full path of an existing directory: the repo root or a worktree, checked by the caller. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A group with the leader on pipes (a mise task): its output goes to the source's log in the `logs` module. */
export interface PipedGroupSpec extends GroupSpec {
  logSource: LogSource;
}

/** A group with the leader in a PTY: the terminal size and the receiver of its output. */
export interface TerminalGroupSpec extends GroupSpec {
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
}

/** The group leader's terminal: keyboard input and the window size. */
export interface GroupTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

/** The output of one run from the `procs` side: bytes go in, the last lines come out into the `exited` state. */
interface RunOutput {
  push(stream: LogStream, chunk: Buffer): void;
  end(stream: LogStream): void;
  lastLines(): string[];
}

/** What `procs` needs from `logs` (§4.2); wired in the facade. */
interface ProcsLogs {
  /** Output that goes to the source's log. */
  open(source: LogSource, runId: string, env: NodeJS.ProcessEnv): RunOutput;
  /** Output only for the state's last lines, masked, without a log: a PTY screen is not log lines (ADR-28). */
  lastLinesOnly(env: NodeJS.ProcessEnv): RunOutput;
}

export interface ProcessGroupsDeps {
  runtime: RuntimeFile;
  logs: ProcsLogs;
  platform: Promise<GroupPlatform>;
  /** A PTY for `startTerminal`; `null` or absent when the runtime has none (Node) or the caller does not use it. */
  terminals?: Promise<TerminalPlatform | null>;
  log: (msg: string) => void;
}

interface Exit {
  code: number | null;
  signal: string | null;
  at: string;
}

/**
 * `live`: the leader is alive. `draining`: the leader ended, but part of the group is still alive (killing is in progress or failed).
 * `exited`: the system confirmed the group is empty; only this phase frees the owner for a new start.
 */
type Phase = { kind: "live" } | { kind: "draining"; exit: Exit } | { kind: "exited"; exit: Exit };

interface Group {
  readonly record: RuntimeGroup;
  readonly control: GroupControl;
  readonly output: RunOutput;
  readonly leaderExit: Promise<Exit>;
  phase: Phase;
  /**
   * The user or a daemon exit ordered the stop before the leader ended by itself; it stays in the `exited` state as
   * `stoppedByUser`. A stop after the leader's end does not change the result: the leader's exit code counts.
   */
  stopRequested: boolean;
  stopping?: Promise<RunState>;
  /** Killing the rest of the group after the leader's end; a stop meanwhile waits for it instead of killing a second time. */
  draining?: Promise<boolean>;
  /** Fulfilled in `finish`, i.e. after the empty group is confirmed; a group that cannot be killed never ends. */
  readonly ended: { promise: Promise<void>; resolve: () => void };
}

export class ProcessGroups {
  private readonly deps: ProcessGroupsDeps;
  private readonly groups = new Map<string, Group>();
  private readonly starting = new Map<string, Promise<RunState>>();
  /** Orphans whose cleanup at start failed: they stay in `runtime.json` until the next start. */
  private orphans: RuntimeGroup[] = [];
  /** The daemon is stopping: new groups would be created after `stopAll` and would outlive the daemon. */
  private closing = false;

  constructor(deps: ProcessGroupsDeps) {
    this.deps = deps;
  }

  /** Starts a group; when the owner already has a group that has not certainly ended, returns its state instead of a second one. */
  start(spec: PipedGroupSpec): Promise<RunState> {
    if (this.closing) return Promise.reject(new SpawnFailure("spawn_failed", "the daemon is stopping"));
    const current = this.groups.get(spec.owner);
    if (current && current.phase.kind !== "exited") return Promise.resolve(stateOf(current));
    let started = this.starting.get(spec.owner);
    if (!started) {
      started = this.spawnGroup(spec, (cwd, platform, runId) =>
        launchPiped(spec, cwd, platform.detached, this.deps.logs.open(spec.logSource, runId, spec.env)),
      )
        .then(({ group }) => stateOf(group))
        .finally(() => this.starting.delete(spec.owner));
      this.starting.set(spec.owner, started);
    }
    return started;
  }

  /**
   * Starts a group whose leader runs in a PTY (§4.4, ADR-26), and returns the terminal for writing and resizing.
   * The owner must be new: a session in a terminal has no "second start" that would hand back the existing one.
   */
  async startTerminal(spec: TerminalGroupSpec): Promise<{ run: RunState; terminal: GroupTerminal }> {
    if (this.closing) throw new SpawnFailure("spawn_failed", "the daemon is stopping");
    if (this.groups.has(spec.owner) || this.starting.has(spec.owner)) throw new Error(`owner ${spec.owner} already has a group`);
    const terminals = await this.deps.terminals;
    if (!terminals) throw new SpawnFailure("terminal_unavailable", "this daemon runtime has no PTY (daemon under Node)");
    const started = this.spawnGroup(spec, async (cwd) => launchTerminal(terminals, spec, cwd, this.deps.logs.lastLinesOnly(spec.env)));
    const run = started.then(({ group }) => stateOf(group));
    // The caller receives a start error through `started`; `starting` only lets others wait for the start to finish.
    run.catch(() => {});
    this.starting.set(spec.owner, run);
    try {
      const { group, launched } = await started;
      return { run: stateOf(group), terminal: launched.leader };
    } finally {
      this.starting.delete(spec.owner);
    }
  }

  state(owner: string): RunState | undefined {
    const group = this.groups.get(owner);
    return group && stateOf(group);
  }

  /**
   * Some group not confirmed empty works in `dir` or a folder under it, e.g. a mise task in a task worktree that would
   * lock the worktree's files on Windows (ADR-59), or a service in a repo the user removes (ADR-83).
   */
  liveIn(dir: string): boolean {
    return [...this.groups.values()].some((group) => group.phase.kind !== "exited" && isInside(dir, group.record.cwd));
  }

  /**
   * The `exited` state of the owner's current group, once the system confirms its end; `undefined` when the owner has no
   * group. For a caller that waits for the result (the batch command), not one that only shows the state.
   */
  async ended(owner: string): Promise<RunState | undefined> {
    await this.starting.get(owner)?.catch(() => undefined);
    const group = this.groups.get(owner);
    if (!group) return undefined;
    await group.ended.promise;
    return stateOf(group);
  }

  /**
   * A gentle stop, after the grace period a kill of the whole group. Returns only after confirming the group is dead;
   * otherwise `stop_unconfirmed`, and the run stays `stopping`, so the stop can be retried.
   */
  async stop(owner: string): Promise<RunState | undefined> {
    // A start in progress (e.g. waiting for `ps`) has no group in the map yet; the stop waits for it instead of reporting none.
    // A failed start leaves no group, so the stop ends as for an owner without a group.
    await this.starting.get(owner)?.catch(() => undefined);
    const group = this.groups.get(owner);
    if (!group) return undefined;
    if (group.phase.kind === "exited") return stateOf(group);
    group.stopping ??= this.stopGroup(group).finally(() => {
      group.stopping = undefined;
    });
    return group.stopping;
  }

  /** Daemon exit: stops all live groups in parallel; groups that could not be stopped are reported in the log. */
  async stopAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.starting.values());
    const live = [...this.groups.entries()].filter(([, g]) => g.phase.kind !== "exited");
    const results = await Promise.allSettled(live.map(([owner]) => this.stop(owner)));
    results.forEach((r, i) => {
      if (r.status === "rejected") this.deps.log(`failed to stop ${live[i]?.[0]}: ${String(r.reason)}`);
    });
  }

  /**
   * Daemon start: groups from `runtime.json` were left by the previous run (a crash, a hard kill). Only a group that is
   * certainly ours is cleaned up (§4.1, `GroupPlatform.reattach`), with the same stop as live groups.
   */
  async sweepOrphans(): Promise<void> {
    const platform = await this.deps.platform;
    const left: RuntimeGroup[] = [];
    for (const orphan of this.readRuntime()) {
      const what = `${orphan.owner} (pid ${orphan.pid}, ${orphan.command.join(" ")})`;
      const target = await platform.reattach(orphan.pid, orphan.identity);
      if (target === "unverified")
        this.deps.log(
          `pid ${orphan.pid} is alive, but it is unknown whether it is the orphaned ${what}; left running and removed from runtime.json`,
        );
      if (typeof target === "string") continue;
      if (await terminate(target, platform.graceMs)) {
        target.release();
        this.deps.log(`cleaned up orphan ${what}`);
      } else {
        this.deps.log(`orphan ${what} survived the kill; will retry on next start`);
        left.push(orphan);
      }
    }
    this.orphans = left;
    this.persist();
  }

  private async spawnGroup<L extends Launched>(
    spec: GroupSpec,
    launch: (cwd: string, platform: GroupPlatform, runId: string) => Promise<L>,
  ): Promise<{ group: Group; launched: L }> {
    await requireDirectory(spec.cwd);
    const platform = await this.deps.platform;
    // Before the start: the leader's output goes to the log with the run identifier from the first byte.
    const runId = randomUUID();
    const launched = await launch(spec.cwd, platform, runId);
    const { leader, leaderExit, output } = launched;
    let control: GroupControl;
    try {
      control = platform.adopt(leader);
    } catch (err) {
      leader.kill();
      throw err;
    }
    const record: RuntimeGroup = {
      runId,
      owner: spec.owner,
      command: [...spec.command],
      cwd: spec.cwd,
      startedAt: new Date().toISOString(),
      pid: leader.pid,
      identity: await platform.identity(leader.pid),
    };
    const group: Group = { record, control, output, leaderExit, phase: { kind: "live" }, stopRequested: false, ended: deferred() };
    this.groups.set(spec.owner, group);
    this.persist();
    leaderExit
      .then((exit) => this.onLeaderExit(group, exit))
      .catch((err: unknown) => this.deps.log(`waiting for group ${spec.owner} to end: ${String(err)}`));
    return { group, launched };
  }

  /** The leader ended by itself or after a stop: the rest of the group is killed, and the run ends only at an empty group. */
  private async onLeaderExit(group: Group, exit: Exit): Promise<void> {
    group.phase = { kind: "draining", exit };
    if (group.stopping) return; // the stop confirms the end itself
    group.draining = (group.control.isEmpty() ? Promise.resolve(true) : killAndWait(group.control)).finally(() => {
      group.draining = undefined;
    });
    if (await group.draining) this.finish(group);
    else this.deps.log(`group ${group.record.owner} (pid ${group.record.pid}) is alive after the kill; it stays in runtime.json`);
  }

  private async stopGroup(group: Group): Promise<RunState> {
    // A leader that ended by itself was not stopped by the user: its exit code is the result.
    if (group.phase.kind === "live") group.stopRequested = true;
    const platform = await this.deps.platform;
    const empty = group.draining ? await group.draining : await terminate(group.control, platform.graceMs);
    if (!empty) {
      throw new DomainError(
        "stop_unconfirmed",
        `${group.record.command.join(" ")} (pid ${group.record.pid}): some processes of the group are still running after the kill`,
      );
    }
    // An empty group means the leader is dead; the `exit` event arrives a moment later at the latest.
    if (group.phase.kind === "live") group.phase = { kind: "draining", exit: await group.leaderExit };
    this.finish(group);
    return stateOf(group);
  }

  /** A group confirmed empty: the end of the run and its removal from `runtime.json`. */
  private finish(group: Group): void {
    if (group.phase.kind !== "draining") return;
    group.phase = { kind: "exited", exit: group.phase.exit };
    group.control.release();
    this.persist();
    group.ended.resolve();
  }

  /**
   * The only write of `runtime.json`: orphans that could not be cleaned up, and groups without a confirmed end.
   * A failed write (e.g. a file held by an antivirus) does not change the in-memory state; the next write catches up.
   */
  private persist(): void {
    const live = [...this.groups.values()].filter((g) => g.phase.kind !== "exited").map((g) => g.record);
    try {
      this.deps.runtime.write([...this.orphans, ...live]);
    } catch (err) {
      this.deps.log(`writing ${this.deps.runtime.path}: ${String(err)}`);
    }
  }

  /** A file that cannot be read is moved aside, so that the next write does not erase the groups recorded in it. */
  private readRuntime(): RuntimeGroup[] {
    try {
      return this.deps.runtime.read();
    } catch (err) {
      const aside = this.deps.runtime.moveAside();
      this.deps.log(`${String(err)}; file set aside as ${aside}, orphans from it will not be cleaned up`);
      return [];
    }
  }
}

/** A started leader before it becomes a group: its output and end are already wired. */
interface Launched {
  leader: GroupLeader & { kill(): void };
  leaderExit: Promise<Exit>;
  output: RunOutput;
}

/** A leader with pipes (stdin, stdout, stderr), like a mise task. */
async function launchPiped(spec: GroupSpec, cwd: string, detached: boolean, output: RunOutput): Promise<Launched> {
  const [program, ...args] = spec.command;
  if (program === undefined) throw new Error("empty command");
  const child = spawn(program, args, { cwd, env: spec.env, detached, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // The process output and end are wired at once: a short mise task may end before the first `await` happens.
  attachOutput(child, output);
  const leaderExit = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, at: new Date().toISOString() }));
  });
  await spawned(child, program);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${program} did not get a PID`);
  const leader = {
    pid,
    closeInput: () => void child.stdin?.end(),
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    kill: () => void child.kill("SIGKILL"),
  };
  return { leader, leaderExit, output };
}

/** A leader in a PTY is also the terminal; its output goes to the caller and to the last lines of the `exited` state. */
function launchTerminal(
  terminals: TerminalPlatform,
  spec: TerminalGroupSpec,
  cwd: string,
  output: RunOutput,
): Launched & { leader: TerminalProcess } {
  const [program] = spec.command;
  if (program === undefined) throw new Error("empty command");
  let leader: TerminalProcess;
  try {
    leader = terminals.spawn({
      command: spec.command,
      cwd,
      env: spec.env,
      cols: spec.cols,
      rows: spec.rows,
      onData: (bytes) => {
        output.push("stdout", Buffer.from(bytes));
        spec.onData(bytes);
      },
    });
  } catch (err) {
    throw spawnFailure(program, err as NodeJS.ErrnoException);
  }
  const leaderExit = leader.exited.then((exit) => ({ ...exit, at: new Date().toISOString() }));
  return { leader, leaderExit, output };
}

/** stdout and stderr are always read, because an unread pipe blocks the process after a few dozen KB (§4.1). */
function attachOutput(child: ChildProcess, output: RunOutput): void {
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) => output.push(stream, chunk));
    child[stream]?.on("end", () => output.end(stream));
  }
  // A process that does not read stdin may close it; EPIPE on a gentle stop is not an error.
  child.stdin?.on("error", () => {});
  // An error after the start (e.g. a failed `kill`) without a listener would end the daemon; the state follows from `exit` anyway.
  child.on("error", () => {});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stateOf(group: Group): RunState {
  const { runId, startedAt, pid } = group.record;
  const { phase } = group;
  if (phase.kind === "live") return { kind: group.stopRequested ? "stopping" : "running", runId, startedAt, pid };
  if (phase.kind === "draining") return { kind: "stopping", runId, startedAt, pid };
  return {
    kind: "exited",
    runId,
    startedAt,
    endedAt: phase.exit.at,
    exitCode: phase.exit.code,
    signal: phase.exit.signal,
    stoppedByUser: group.stopRequested,
    lastLines: group.output.lastLines(),
  };
}

/** One way to stop for live groups and orphans: gently, after the grace period a kill, then waiting for an empty group. */
async function terminate(control: GroupControl, graceMs: number): Promise<boolean> {
  control.askToStop();
  return (await waitUntil(() => control.isEmpty(), graceMs)) || killAndWait(control);
}

async function killAndWait(control: GroupControl): Promise<boolean> {
  control.kill();
  return waitUntil(() => control.isEmpty(), KILL_WAIT_MS);
}

async function requireDirectory(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new SpawnFailure("cwd_invalid", `the working directory must be a full path: ${cwd}`);
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new SpawnFailure("cwd_invalid", `the working directory does not exist: ${cwd}`);
}

/** Waits for `spawn` or `error`: only then is it known whether the program started at all. */
function spawned(child: ChildProcess, program: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err: NodeJS.ErrnoException) => reject(spawnFailure(program, err)));
  });
}
