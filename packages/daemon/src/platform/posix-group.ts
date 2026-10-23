import { execFile } from "node:child_process";
import { type GroupControl, type GroupLeader, type GroupPlatform, isAlive, signalExists } from "./process-group.ts";

/**
 * Grupa procesów na macOS i Linuksie: lider startuje w nowej sesji (`detached` = `setsid`), więc jego PID jest
 * identyfikatorem grupy, a potomkowie ją dziedziczą. Sygnał do `-pgid` dostaje cała grupa. Po twardym zabiciu
 * daemona grupa żyje dalej i sprząta ją dopiero następny start (`reattach`).
 */

const GRACE_MS = 5000;

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: w grupie nie ma już procesów; wynik i tak sprawdza `isEmpty`.
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

/** Czas startu procesu z `ps` (`lstart`, z dokładnością do sekundy); razem z PID-em odróżnia proces od recyklingu. */
function identity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    // Stała strefa i język: zapis musi wyjść tak samo z terminala i z Findera (inne TZ i LC_TIME).
    const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2000, env }, (err, stdout) => {
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
