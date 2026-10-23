import type { ChildProcess } from "node:child_process";

/**
 * Grupa procesów (§4.1) od strony systemu: jak uruchomić lidera, żeby jego potomkowie byli z nim jedną jednostką,
 * jak ją zatrzymać i jak sprawdzić, że nie żyje. Moduł `procs` zna tylko ten interfejs i sam decyduje o kolejności
 * kroków; Windows ma Job Object (pod Bun, ADR-20), macOS i Linux nową sesję POSIX (`setsid`) z sygnałami do `-pgid`.
 */

/** Metody nie rzucają: błąd systemu przy zatrzymywaniu wychodzi jako grupa, która nie jest pusta. */
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

export interface GroupPlatform {
  /** `setsid` na POSIX; na Windowsie lider zostaje w konsoli daemona, a grupę tworzy job. */
  detached: boolean;
  /** Czas łaski między `askToStop` a `kill`. */
  graceMs: number;
  /** Robi z uruchomionego lidera grupę. Rzuca, gdy system odmówi (wtedy wołający zabija lidera). */
  adopt(child: ChildProcess): GroupControl;
  /** Tożsamość lidera do `runtime.json` (czas startu procesu), `null`, gdy system jej nie podaje. */
  identity(pid: number): Promise<string | null>;
  /**
   * Grupa z poprzedniego działania daemona (`runtime.json`), jeśli wciąż żyje i na pewno jest nasza; `unverified`,
   * gdy żyje proces o tym PID-ie, ale nie da się potwierdzić, że to nasz lider (PID z recyklingu).
   */
  reattach(pid: number, identity: string | null): Promise<GroupControl | "gone" | "unverified">;
}

/** Sygnał 0 sprawdza istnienie; EPERM znaczy, że proces żyje, tylko należy do innego użytkownika. */
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
