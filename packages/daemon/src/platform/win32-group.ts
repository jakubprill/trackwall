import { execFile } from "node:child_process";
import { type GroupControl, type GroupLeader, type GroupPlatform, isAlive } from "./process-group.ts";
import type { Job } from "./win32-job.ts";

/**
 * A process group on Windows (ADR-20). Under Bun (a binary from `--compile`) the leader goes into a Job Object with
 * `KILL_ON_JOB_CLOSE` right after its start; descendants inherit the job, and closing the handle, also on a hard kill of
 * the daemon, kills the whole group. Under Node there is no FFI, so the group is the parent–child tree from `taskkill /T`:
 * an empty group there only means "the leader is dead", and a descendant whose parent is already dead drops out of the tree (a gap in §8).
 *
 * A gentle stop is closing the leader's input: Ctrl+C (`GenerateConsoleCtrlEvent`) needs a shared console, which
 * a process with a hidden window does not have. Most development servers do not listen for stdin closing, hence the short grace
 * period; a process in ConPTY gets `CTRL_CLOSE_EVENT` when the terminal closes, as when a console window closes.
 */

const GRACE_MS = 2000;

/** An FFI error while stopping must not end the daemon; the group is then simply not confirmed as empty. */
function jobControl(job: Job, leader: GroupLeader): GroupControl {
  return {
    askToStop: () => leader.closeInput(),
    kill: () => {
      try {
        job.terminate(1);
      } catch {
        // `isEmpty` will show that the group is alive.
      }
    },
    isEmpty: () => {
      try {
        return job.activeProcesses() === 0;
      } catch {
        return false;
      }
    },
    release: () => job.close(),
  };
}

function treeControl(leader: GroupLeader): GroupControl {
  return {
    askToStop: () => leader.closeInput(),
    kill: () => void execFile("taskkill", ["/T", "/F", "/PID", String(leader.pid)], { windowsHide: true }, () => {}),
    isEmpty: () => leader.hasExited(),
    release: () => {},
  };
}

export async function win32Groups(withJobs: boolean): Promise<GroupPlatform> {
  const JobClass = withJobs ? (await import("./win32-job.ts")).Job : undefined;
  return {
    detached: false,
    graceMs: GRACE_MS,
    adopt: (leader) => {
      if (!JobClass) return treeControl(leader);
      const job = new JobClass();
      try {
        job.assign(leader.pid);
      } catch (err) {
        job.close();
        throw err;
      }
      return jobControl(job, leader);
    },
    // Under Bun orphans do not arise (the job kills the group with the daemon), and under Node there is no cheap process start time,
    // so a live PID from `runtime.json` is reported, but not killed.
    identity: async () => null,
    reattach: async (pid) => (isAlive(pid) ? "unverified" : "gone"),
  };
}
