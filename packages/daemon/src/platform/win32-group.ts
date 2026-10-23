import { type ChildProcess, execFile } from "node:child_process";
import { type GroupControl, type GroupPlatform, isAlive } from "./process-group.ts";

/**
 * Grupa procesów na Windowsie (ADR-20). Pod Bun (binarka z `--compile`) lider trafia do Job Object z
 * `KILL_ON_JOB_CLOSE` zaraz po starcie; potomkowie dziedziczą job, a zamknięcie uchwytu, także przy twardym zabiciu
 * daemona, zabija całą grupę. Pod Node nie ma FFI, więc grupę wyznacza drzewo rodzic–dziecko z `taskkill /T`:
 * potomek, którego rodzic już nie żyje, wypada z drzewa (luka opisana w §9).
 *
 * Łagodny stop to zamknięcie stdin lidera: Ctrl+C (`GenerateConsoleCtrlEvent`) wymaga wspólnej konsoli, której
 * proces z ukrytym oknem nie ma. Większość serwerów deweloperskich go nie słucha, stąd krótki czas łaski.
 */

const GRACE_MS = 2000;

function jobControl(job: import("./win32-job.ts").Job, child: ChildProcess): GroupControl {
  return {
    askToStop: () => void child.stdin?.end(),
    kill: () => job.terminate(1),
    isEmpty: () => job.activeProcesses() === 0,
    release: () => job.close(),
  };
}

function treeControl(child: ChildProcess, pid: number): GroupControl {
  return {
    askToStop: () => void child.stdin?.end(),
    kill: () => void execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => {}),
    isEmpty: () => child.exitCode !== null || child.signalCode !== null,
    release: () => {},
  };
}

export async function win32Groups(withJobs: boolean): Promise<GroupPlatform> {
  const Job = withJobs ? (await import("./win32-job.ts")).Job : undefined;
  return {
    detached: false,
    graceMs: GRACE_MS,
    adopt: (child) => {
      const pid = child.pid;
      if (pid === undefined) throw new Error("proces nie ma PID-u");
      if (!Job) return treeControl(child, pid);
      const job = new Job();
      try {
        job.assign(pid);
      } catch (err) {
        job.close();
        throw err;
      }
      return jobControl(job, child);
    },
    // Pod Bun sieroty nie powstają (job zabija grupę z daemonem), a pod Node nie ma taniego czasu startu procesu,
    // więc żywy PID z `runtime.json` jest zgłaszany, ale nie zabijany.
    identity: async () => null,
    killOrphan: async (pid) => (isAlive(pid) ? "unverified" : "gone"),
  };
}
