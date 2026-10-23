import { type ChildProcess, execFile } from "node:child_process";
import { type GroupControl, type GroupPlatform, isAlive, type OrphanOutcome, waitUntil } from "./process-group.ts";

/**
 * Grupa procesów na macOS i Linuksie: lider startuje w nowej sesji (`detached` = `setsid`), więc jego PID jest
 * identyfikatorem grupy, a potomkowie ją dziedziczą. Sygnał do `-pgid` dostaje cała grupa. Po twardym zabiciu
 * daemona grupa żyje dalej i sprząta ją dopiero następny start (`killOrphan`).
 */

const GRACE_MS = 5000;
const KILL_WAIT_MS = 5000;

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    // ESRCH: w grupie nie ma już żadnego procesu. EPERM: proces grupy zmienił użytkownika, ale nadal żyje.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pgid: number): boolean {
  return signalGroup(pgid, 0);
}

function control(pgid: number): GroupControl {
  return {
    askToStop: () => void signalGroup(pgid, "SIGTERM"),
    kill: () => void signalGroup(pgid, "SIGKILL"),
    isEmpty: () => !groupAlive(pgid),
    release: () => {},
  };
}

/** Czas startu procesu z `ps` (`lstart`, z dokładnością do sekundy); razem z PID-em odróżnia proces od recyklingu. */
function identity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000 }, (err, stdout) => {
      const value = stdout.trim();
      resolve(err || value === "" ? null : value);
    });
  });
}

/**
 * Grupa o identyfikatorze lidera istnieje tylko dzięki procesom, które ją dziedziczą, a system nie nadaje tego PID-u
 * nikomu, dopóki grupa żyje. Gdy lider nie żyje, a grupa tak, to wciąż nasza grupa. Gdy lider żyje, musi mieć ten sam
 * czas startu: inaczej PID dostał nowy proces, który sam założył sesję.
 */
async function killOrphan(pgid: number, recorded: string | null): Promise<OrphanOutcome> {
  if (!groupAlive(pgid)) return "gone";
  if (isAlive(pgid) && (recorded === null || (await identity(pgid)) !== recorded)) return "unverified";
  signalGroup(pgid, "SIGTERM");
  if (await waitUntil(() => !groupAlive(pgid), GRACE_MS)) return "killed";
  signalGroup(pgid, "SIGKILL");
  return (await waitUntil(() => !groupAlive(pgid), KILL_WAIT_MS)) ? "killed" : "alive";
}

export const posixGroups: GroupPlatform = {
  detached: true,
  graceMs: GRACE_MS,
  adopt: (child: ChildProcess) => {
    if (child.pid === undefined) throw new Error("proces nie ma PID-u");
    return control(child.pid);
  },
  identity,
  killOrphan,
};
