import { countLabel, type NewTaskBase, type ServerCheckState, type SyncResult } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";
import { newOnServerAt } from "./new-on-server.ts";
import { syncResultMessage } from "./sync-state.ts";

/**
 * The line above "Create task" about where the task starts (ADR-297): a task branches from the repo's own default branch
 * (`Task.base`), so a default branch behind the server gives its agent older code than the server's. The line says so
 * and offers that one repo's sync; it never holds the start. Tests in `test/new-task-base.test.ts`.
 */

export type NewTaskBaseTone = "warning" | "info" | "ok";

export interface NewTaskBaseLine {
  tone: NewTaskBaseTone;
  text: string;
  /** The button's label where a sync can move the branch ("Sync main"); `null` without one. */
  sync: string | null;
}

/**
 * What the form says before a sync: the default branch lacks commits of the remote one as of the last fetch, or the
 * server check found newer ones the repo has not fetched; diverged, a sync cannot move it, so the line only says so.
 * `null` when the task starts from the server's code as far as Trackwall knows, or nothing can be compared.
 */
export function newTaskBaseLine(
  repo: string,
  base: NewTaskBase | null,
  serverCheck: ServerCheckState | undefined,
  now: Date,
): NewTaskBaseLine | null {
  if (base === null) return null;
  const { branch, remoteBranch, behind, ahead, fetchedAt } = base;
  if (behind > 0 && ahead > 0)
    return {
      tone: "info",
      text: `${branch} and ${remoteBranch} have diverged (${ahead} local, ${behind} remote), so a sync leaves ${branch} as it is; merge them in the repo's Shell. The task starts from your ${branch}.`,
      sync: null,
    };
  if (behind > 0)
    return {
      tone: "warning",
      text: `${branch} is ${countLabel(behind, { one: "commit", other: "commits" })} behind ${remoteBranch}${fetchedAt === null ? "" : ` (fetched ${relativeTime(fetchedAt, now)})`}. The task starts from ${branch}, so its agent would work on older code.`,
      sync: `Sync ${branch}`,
    };
  const checkedAt = newOnServerAt(serverCheck, repo, remoteBranch, fetchedAt);
  if (checkedAt === null) return null;
  return {
    tone: "warning",
    text: `The server has new commits on ${branch} that ${repo} has not fetched (checked ${relativeTime(checkedAt, now)}). The task would start without them.`,
    sync: `Sync ${branch}`,
  };
}

/** What the form says after "Sync main": the sync's own sentences, as "Sync all" gives them for the repo. */
export function syncedTaskBaseLine(result: SyncResult): NewTaskBaseLine {
  return { tone: result.state === "skipped" ? "warning" : "ok", text: syncResultMessage(result), sync: null };
}
