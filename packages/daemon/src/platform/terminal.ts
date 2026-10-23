import type { GroupLeader } from "./process-group.ts";
import { runtimeInfo } from "./runtime.ts";

/**
 * PTY (§4.4, ADR-26): proces w pseudoterminalu należącym do daemona, z którego okno terminala w UI dostaje ekran,
 * a do którego wysyła klawisze. Na Windowsie to ConPTY, na macOS i Linuksie zwykły PTY, w którym proces jest liderem
 * nowej sesji POSIX, więc jego PID jest też identyfikatorem grupy procesów (§4.1). Daje go `Bun.spawn({ terminal })`
 * (spike z etapu 1, ADR-1); Node nie ma PTY bez natywnego addonu, więc pod Node sesji agentów nie ma.
 */

export interface TerminalSpec {
  /** Program (pełna ścieżka) i argumenty, bez powłoki. */
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  /** Wyjście terminala w kawałkach, jak przyszło; UTF-8 może być rozcięte między kawałkami. */
  onData: (bytes: Uint8Array) => void;
}

interface TerminalExit {
  code: number | null;
  signal: string | null;
}

/**
 * Proces w PTY jest liderem grupy (`GroupLeader`): `closeInput` zamyka terminal, a na Windowsie ConPTY wysyła wtedy
 * procesom konsoli `CTRL_CLOSE_EVENT`, więc to łagodna prośba o koniec, tak jak zamknięcie okna terminala.
 */
export interface TerminalProcess extends GroupLeader {
  /** Koniec lidera, gdy całe jego wyjście już przyszło do `onData`, a terminal jest zamknięty. */
  exited: Promise<TerminalExit>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Zabija samego lidera (SIGKILL), gdy platforma nie przyjęła go do grupy. */
  kill(): void;
}

export interface TerminalPlatform {
  /** Rzuca błąd `spawn` (z `code`, np. `ENOENT`), gdy program nie wystartował. */
  spawn(spec: TerminalSpec): TerminalProcess;
}

let platform: Promise<TerminalPlatform | null> | undefined;

/** PTY bieżącego runtime'u albo `null` pod Node; ładowane raz. */
export function terminalPlatform(): Promise<TerminalPlatform | null> {
  platform ??= runtimeInfo().name === "bun" ? import("./bun-terminal.ts").then((m) => m.bunTerminals) : Promise.resolve(null);
  return platform;
}
