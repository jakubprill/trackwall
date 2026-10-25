/**
 * A process group (§4.1) from the system side: how to start the leader so that its descendants are one unit with it,
 * how to stop it and how to check that it is dead. The `procs` module knows only this interface and decides the order
 * of steps itself; Windows has a Job Object (under Bun, ADR-20), macOS and Linux a new POSIX session (`setsid`) with signals to `-pgid`.
 */

/** The methods do not throw: a system error while stopping comes out as a group that is not empty. */
export interface GroupControl {
  /** A gentle request to end: SIGTERM to the whole group, on Windows closing the leader's input. */
  askToStop(): void;
  /** Kills every process of the group, including those left after the leader exited. */
  kill(): void;
  /** `true` only when the system confirms that no process of the group is alive. */
  isEmpty(): boolean;
  /** Frees the group's system resources (the job handle); called after confirming the group is empty. */
  release(): void;
}

/**
 * The group leader as the platform sees it: a process with pipes or a process in a PTY (`terminal.ts`). The platform needs
 * the PID, a gentle request to end from the input side, and whether the leader has already ended.
 */
export interface GroupLeader {
  pid: number;
  /** Closes the leader's input: the stdin of a process with pipes or the terminal (ConPTY then sends `CTRL_CLOSE_EVENT`). */
  closeInput(): void;
  hasExited(): boolean;
}

export interface GroupPlatform {
  /** `setsid` on POSIX; on Windows the leader stays in the daemon's console, and the job makes the group. */
  detached: boolean;
  /** The grace period between `askToStop` and `kill`. */
  graceMs: number;
  /** Makes a group from a started leader. Throws when the system refuses (the caller then kills the leader). */
  adopt(leader: GroupLeader): GroupControl;
  /** The leader's identity for `runtime.json` (the process start time), `null` when the system does not give it. */
  identity(pid: number): Promise<string | null>;
  /**
   * A group from the previous daemon run (`runtime.json`), if it is still alive and certainly ours; `unverified`
   * when a process with that PID is alive, but it cannot be confirmed to be our leader (a recycled PID).
   */
  reattach(pid: number, identity: string | null): Promise<GroupControl | "gone" | "unverified">;
}

/** Signal 0 checks existence; EPERM means the process is alive, it just belongs to another user. */
export function signalExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isAlive(pid: number): boolean {
  return signalExists(pid);
}

export async function waitUntil(fn: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return true;
}
