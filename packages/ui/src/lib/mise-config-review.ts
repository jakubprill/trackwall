import type { TaskMiseConfig } from "@trackwall/protocol";

/**
 * Which version of a task worktree's changed mise config the task panel shows (ADR-59). The first version with changes
 * stays on screen while polls bring newer ones, so the digest the user trusts is that of the text they read; a newer
 * version shows only when the user asks for it. A config without changes, or the one the user just trusted while the
 * poll has not caught up yet, ends the warning. A failed poll keeps what is shown, as the panel then shows the error.
 */
export function shownMiseConfig(
  shown: TaskMiseConfig | undefined,
  latest: TaskMiseConfig | undefined,
  trustedDigest: string | undefined,
): TaskMiseConfig | undefined {
  if (!latest) return shown;
  if (latest.changes.length === 0 || latest.digest === trustedDigest) return undefined;
  return shown ?? latest;
}

/** The agent changed the config again since the shown version: trusting is held until the user shows the new one. */
export function changedSinceShown(shown: TaskMiseConfig, latest: TaskMiseConfig | undefined): boolean {
  return latest !== undefined && latest.changes.length > 0 && latest.digest !== shown.digest;
}
