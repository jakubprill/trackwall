import { execFile } from "node:child_process";
import { type GroupControl, type GroupLeader, type GroupPlatform, isAlive } from "./process-group.ts";
import type { Job } from "./win32-job.ts";

/**
 * Grupa procesów na Windowsie (ADR-20). Pod Bun (binarka z `--compile`) lider trafia do Job Object z
 * `KILL_ON_JOB_CLOSE` zaraz po starcie; potomkowie dziedziczą job, a zamknięcie uchwytu, także przy twardym zabiciu
 * daemona, zabija całą grupę. Pod Node nie ma FFI, więc grupę wyznacza drzewo rodzic–dziecko z `taskkill /T`:
 * pusta grupa znaczy tam tylko „lider nie żyje”, a potomek, którego rodzic już nie żyje, wypada z drzewa (luka w §8).
 *
 * Łagodny stop to zamknięcie wejścia lidera: Ctrl+C (`GenerateConsoleCtrlEvent`) wymaga wspólnej konsoli, której
 * proces z ukrytym oknem nie ma. Większość serwerów deweloperskich zamknięcia stdin nie słucha, stąd krótki czas
 * łaski; proces w ConPTY dostaje przy zamknięciu terminala `CTRL_CLOSE_EVENT`, jak przy zamknięciu okna konsoli.
 */

const GRACE_MS = 2000;

/** Błąd FFI przy zatrzymywaniu nie może zakończyć daemona; grupa wtedy po prostu nie jest potwierdzona jako pusta. */
function jobControl(job: Job, leader: GroupLeader): GroupControl {
  return {
    askToStop: () => leader.closeInput(),
    kill: () => {
      try {
        job.terminate(1);
      } catch {
        // `isEmpty` pokaże, że grupa żyje.
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
    // Pod Bun sieroty nie powstają (job zabija grupę z daemonem), a pod Node nie ma taniego czasu startu procesu,
    // więc żywy PID z `runtime.json` jest zgłaszany, ale nie zabijany.
    identity: async () => null,
    reattach: async (pid) => (isAlive(pid) ? "unverified" : "gone"),
  };
}
