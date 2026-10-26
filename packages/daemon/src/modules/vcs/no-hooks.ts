import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An empty hooks directory for one git command (`core.hooksPath`): `--no-verify` skips only some hooks, while a push or a
 * ref update also runs `reference-transaction`, and a repo's hooks may come from a directory an agent writes (`.husky`).
 * For the task branch push (ADR-77) and the local config store's commits and push (ADR-86).
 */
export async function withoutHooks<T>(run: (hooksPath: string) => Promise<T>): Promise<T> {
  const noHooks = mkdtempSync(join(tmpdir(), "trackwall-no-hooks-"));
  try {
    return await run(`core.hooksPath=${noHooks}`);
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
}
