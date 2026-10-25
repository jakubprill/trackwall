import { execFile } from "node:child_process";
import { type GroupControl, type GroupLeader, type GroupPlatform, isAlive, signalExists } from "./process-group.ts";

/**
 * A process group on macOS and Linux: the leader starts in a new session (`detached` = `setsid`), so its PID is
 * the group identifier, and descendants inherit it. A signal to `-pgid` reaches the whole group. After a hard kill of
 * the daemon the group lives on, and only the next start cleans it up (`reattach`).
 */

const GRACE_MS = 5000;

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: the group has no processes left; `isEmpty` checks the result anyway.
  }
}

function control(pgid: number): GroupControl {
  return {
    askToStop: () => signalGroup(pgid, "SIGTERM"),
    kill: () => signalGroup(pgid, "SIGKILL"),
    isEmpty: () => !signalExists(-pgid),
    release: () => {},
  };
}

/** The process start time from `ps` (`lstart`, to the second); together with the PID it tells a process from a recycled PID. */
function identity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    // A fixed time zone and locale: the output must be the same from a terminal and from Finder (different TZ and LC_TIME).
    const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2000, env }, (err, stdout) => {
      const value = stdout.trim();
      resolve(err || value === "" ? null : value);
    });
  });
}

/**
 * A group with the leader's identifier exists only thanks to the processes that inherit it, and the system gives that PID
 * to nobody while the group lives. When the leader is dead but the group is not, it is still our group. When the leader is alive,
 * it must have the same start time: otherwise the PID went to a new process that set up a session itself.
 */
async function reattach(pgid: number, recorded: string | null): Promise<GroupControl | "gone" | "unverified"> {
  if (!signalExists(-pgid)) return "gone";
  if (isAlive(pgid) && (recorded === null || (await identity(pgid)) !== recorded)) return "unverified";
  return control(pgid);
}

export const posixGroups: GroupPlatform = {
  detached: true,
  graceMs: GRACE_MS,
  adopt: (leader: GroupLeader) => control(leader.pid),
  identity,
  reattach,
};
