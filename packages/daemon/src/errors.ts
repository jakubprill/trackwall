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
  readonly reason: "program_not_found" | "cwd_invalid" | "terminal_unavailable" | "spawn_failed";

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

/**
 * Odczyt klucza `workspace.yaml`, którego zły wpis nie może zabrać reszty widoku (graf, ADR-29): `invalid_config` daje
 * wartość zastępczą i komunikat do pokazania, każdy inny błąd idzie dalej.
 */
export function configOrProblem<T>(read: () => T, fallback: T): { value: T; problem: string | null } {
  try {
    return { value: read(), problem: null };
  } catch (err) {
    if (!(err instanceof DomainError && err.code === "invalid_config")) throw err;
    return { value: fallback, problem: err.message };
  }
}

/** Komunikat błędu dla użytkownika: wyjątek z kodu albo cokolwiek innego, co zostało rzucone. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
