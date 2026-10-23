import type { ErrorCode } from "@trackwall/protocol";

/**
 * Błąd, który moduł zgłasza świadomie i który transport ma pokazać klientowi z kodem i treścią.
 * Każdy inny wyjątek API zamienia na `internal` bez szczegółów.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Proces nie wystartował: wołający rozróżnia brak programu od złego katalogu roboczego i od reszty. */
export class SpawnFailure extends Error {
  readonly reason: "program_not_found" | "cwd_invalid" | "spawn_failed";

  constructor(reason: SpawnFailure["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Błąd `spawn` jako `SpawnFailure` z komunikatem po polsku; `ENOENT` znaczy brak programu w `PATH`. */
export function spawnFailure(program: string, err: NodeJS.ErrnoException): SpawnFailure {
  return err.code === "ENOENT"
    ? new SpawnFailure("program_not_found", `nie znaleziono programu ${program} w PATH`)
    : new SpawnFailure("spawn_failed", `nie udało się uruchomić ${program}: ${err.message}`);
}
