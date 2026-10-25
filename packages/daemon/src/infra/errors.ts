import type { ErrorCode } from "@trackwall/protocol";

/**
 * An error a module raises on purpose and that the transport is to show the client with its code and message.
 * The API turns any other exception into `internal` without details.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The process did not start: the caller tells a missing program from a bad working directory and from the rest. */
export class SpawnFailure extends Error {
  readonly reason: "program_not_found" | "cwd_invalid" | "terminal_unavailable" | "spawn_failed";

  constructor(reason: SpawnFailure["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** A `spawn` error as a `SpawnFailure` with a message for the user; `ENOENT` means the program is not in `PATH`. */
export function spawnFailure(program: string, err: NodeJS.ErrnoException): SpawnFailure {
  return err.code === "ENOENT"
    ? new SpawnFailure("program_not_found", `program ${program} not found in PATH`)
    : new SpawnFailure("spawn_failed", `failed to start ${program}: ${err.message}`);
}

/**
 * Reads a `workspace.yaml` key whose bad entry must not take away the rest of the view (graph, ADR-29): `invalid_config` gives
 * a fallback value and a message to show, any other error propagates.
 */
export function configOrProblem<T>(read: () => T, fallback: T): { value: T; problem: string | null } {
  try {
    return { value: read(), problem: null };
  } catch (err) {
    if (!(err instanceof DomainError && err.code === "invalid_config")) throw err;
    return { value: fallback, problem: err.message };
  }
}

/** An error message for the user: an exception from code or anything else that was thrown. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
