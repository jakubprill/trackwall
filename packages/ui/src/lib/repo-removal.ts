import { countLabel, type RepoStatus, type RunningMiseTask, type SessionList, trackedChanges } from "@trackwall/protocol";
import { PROPOSAL_ITEM_KEY, type RepoActivityItem, repoActivity } from "./repo-activity.ts";

/**
 * Removing a repo from the Repos view (ADR-303): what stops it, whether the typed name confirms it, and what the folder
 * takes with it that is not on the server. The daemon checks the same and refuses a repo with work in it; the panel only
 * says so first, with a way to each piece of work.
 */

/**
 * The work that keeps a repo from being removed: sessions in its root, its tasks and its running mise tasks, the items of
 * "In this repo" without the proposals, which the removal rejects instead. Services and terminals the daemon names itself.
 */
export function removalBlockers(repo: string, list: SessionList | undefined, running: readonly RunningMiseTask[]): RepoActivityItem[] {
  return repoActivity(repo, list, running).filter((item) => !item.key.startsWith(PROPOSAL_ITEM_KEY));
}

/** The typed name confirms the removal only when it is the repo's name exactly, as on GitHub: no trimming, no case folding. */
export function removalConfirmed(typed: string, repo: string): boolean {
  return typed === repo;
}

/**
 * What goes with the folder that is not on the server, as one sentence, or `null` when git says there is nothing or the
 * status is not known: "It takes along what is not on the server: 1 changed file, 1 new file, 2 commits not pushed."
 */
export function notOnServer(status: RepoStatus): string | null {
  if (status.kind !== "ok") return null;
  const changed = trackedChanges(status);
  const ahead = status.upstream?.ahead ?? 0;
  const parts = [
    changed > 0 && countLabel(changed, { one: "changed file", other: "changed files" }),
    status.untracked > 0 && countLabel(status.untracked, { one: "new file", other: "new files" }),
    ahead > 0 && `${countLabel(ahead, { one: "commit", other: "commits" })} not pushed`,
    status.branch !== null && status.upstream === null && "a branch with no upstream",
  ].filter((part) => typeof part === "string");
  return parts.length === 0 ? null : `It takes along what is not on the server: ${parts.join(", ")}.`;
}
