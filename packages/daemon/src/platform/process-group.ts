import type { ChildProcess } from "node:child_process";

/**
 * Grupa procesów (§4.1) od strony systemu: jak uruchomić lidera, żeby jego potomkowie byli z nim jedną jednostką,
 * jak ją zatrzymać i jak sprawdzić, że nie żyje. Moduł `procs` zna tylko ten interfejs; Windows ma Job Object
 * (pod Bun, ADR-20), macOS i Linux nową sesję POSIX (`setsid`) z sygnałami do `-pgid`.
 */
export interface GroupControl {
  /** Łagodna prośba o koniec: SIGTERM do całej grupy, na Windowsie zamknięcie stdin lidera. */
  askToStop(): void;
  /** Zabija każdy proces grupy, także te, które zostały po wyjściu lidera. */
  kill(): void;
  /** `true` dopiero wtedy, gdy system potwierdza, że żaden proces grupy nie żyje. */
  isEmpty(): boolean;
  /** Zwalnia zasoby systemowe grupy (uchwyt joba); wołane po potwierdzeniu, że grupa jest pusta. */
  release(): void;
}

/** Wynik sprzątania sieroty z `runtime.json` przy starcie daemona. */
export type OrphanOutcome =
  | "gone"
  | "killed"
  /** Lider żyje, ale nie da się potwierdzić, że to ten sam proces (PID z recyklingu albo brak sposobu na sprawdzenie). */
  | "unverified"
  /** Grupa przeżyła zabicie. */
  | "alive";

export interface GroupPlatform {
  /** `setsid` na POSIX; na Windowsie lider zostaje w konsoli daemona, a grupę tworzy job. */
  detached: boolean;
  /** Czas łaski między `askToStop` a `kill`. */
  graceMs: number;
  /** Robi z uruchomionego lidera grupę. Rzuca, gdy system odmówi (wtedy wołający zabija lidera). */
  adopt(child: ChildProcess): GroupControl;
  /** Tożsamość lidera do `runtime.json` (czas startu procesu), `null`, gdy system jej nie podaje. */
  identity(pid: number): Promise<string | null>;
  /** Zabija grupę z poprzedniego działania daemona, jeśli lider to wciąż ten sam proces. */
  killOrphan(pid: number, identity: string | null): Promise<OrphanOutcome>;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitUntil(fn: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return true;
}
