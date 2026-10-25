import { countLabel, type SyncRepo, type SyncRun, type SyncSkipReason, type SyncWorkingTree } from "@trackwall/protocol";
import { workingTreeLabel } from "./format.ts";
import type { StatusTone } from "./repo-status.ts";

/** Sync in the UI (ADR-21): the tone and short text of a repo's result and the overall progress; tests in `test/sync-state.test.ts`. */

/** Short, because it stands in a row of the repo list; the daemon's full sentence is in the sync panel. */
const SKIP_LABEL: Record<SyncSkipReason, string> = {
  "no-remote": "no remote",
  "no-default-branch": "no default branch",
  "no-local-branch": "no local branch",
  dirty: "local changes",
  diverged: "diverged branch",
  ahead: "unpushed commits",
  "checked-out-elsewhere": "in another worktree",
};

export function syncRepoTone(repo: SyncRepo): { tone: StatusTone; label: string } {
  switch (repo.state) {
    case "waiting":
      return { tone: "warning", label: "waiting" };
    case "running":
      return { tone: "warning", label: "syncing…" };
    case "updated":
      return { tone: "ok", label: `+${countLabel(repo.commits, { one: "commit", other: "commits" })}` };
    case "up-to-date":
      return { tone: "ok", label: "up to date" };
    case "skipped":
      return { tone: "warning", label: `skipped: ${SKIP_LABEL[repo.reason]}` };
    case "failed":
      return { tone: "error", label: "sync failed" };
  }
}

/**
 * Full sentences about a repo's result (ADR-34): what happened to the default branch, whether that changed files in the
 * working directory (no when another branch is checked out), and that local changes were left untouched. Without this an
 * "up to date" repo with four changed files looks like a sync that did nothing. A running repo has nothing to say yet.
 */
export function syncMessage(repo: SyncRepo): string | undefined {
  switch (repo.state) {
    case "waiting":
    case "running":
      return undefined;
    case "failed":
      return sentences([repo.message]);
    case "updated":
      return sentences([
        `${repo.branch} moved ${countLabel(repo.commits, { one: "commit", other: "commits" })} forward to ${repo.remoteBranch}`,
        repo.workingTree &&
          (repo.workingTree.branch === repo.branch
            ? "Files in the working directory were updated"
            : `${checkedOut(repo.workingTree)}, so files in the working directory did not change`),
        localChanges(repo.workingTree),
      ]);
    case "up-to-date":
      return sentences([
        `${repo.branch} already matches ${repo.remoteBranch}`,
        repo.workingTree && repo.workingTree.branch !== repo.branch
          ? `${checkedOut(repo.workingTree)}; sync only moves ${repo.branch}`
          : undefined,
        localChanges(repo.workingTree),
      ]);
    case "skipped":
      return sentences([repo.message, localChanges(repo.workingTree)]);
  }
}

function checkedOut(tree: SyncWorkingTree): string {
  return tree.branch === null ? "The working directory has a detached HEAD" : `The working directory is on ${tree.branch}`;
}

/** Without the working directory state (`git status` after the sync failed) there is nothing to add. */
function localChanges(tree: SyncWorkingTree | null): string | undefined {
  const label = tree && workingTreeLabel(tree.changed, tree.untracked);
  return label ? `Uncommitted files stay as they are: ${label}` : undefined;
}

/** Sentences from the daemon (`message`) have no full stop at the end, and git messages do; hence a full stop only where it is missing. */
function sentences(parts: (string | null | undefined)[]): string {
  return parts
    .filter((p) => typeof p === "string")
    .map((p) => (p.endsWith(".") ? p : `${p}.`))
    .join(" ");
}

export interface SyncBadge {
  tone: StatusTone;
  label: string;
  /** The sentence for the tooltip; a running repo has none. */
  message: string | undefined;
}

/**
 * The result under the repo's state in the list, also "up to date", because without it you cannot see that the sync
 * reached the repo. A result stops being true over time (new commits on the remote), so the tooltip of a finished repo
 * says when the sync started.
 */
export function listSyncBadge(repo: SyncRepo | undefined, syncedAgo: string): SyncBadge | undefined {
  if (!repo) return undefined;
  const message = syncMessage(repo);
  return { ...syncRepoTone(repo), message: message && `${message} Synced ${syncedAgo}.` };
}

export interface SyncProgress {
  /** Repos with a result (skipped and failed ones too). */
  done: number;
  total: number;
  updated: number;
  upToDate: number;
  skipped: number;
  failed: number;
}

export function syncProgress(run: SyncRun): SyncProgress {
  const count = (state: SyncRepo["state"]) => run.repos.filter((r) => r.state === state).length;
  const pending = count("waiting") + count("running");
  return {
    done: run.repos.length - pending,
    total: run.repos.length,
    updated: count("updated"),
    upToDate: count("up-to-date"),
    skipped: count("skipped"),
    failed: count("failed"),
  };
}

/** A repo's result by path, not by identifier: that can change together with the directory name (ADR-18). */
export function syncedByPath(run: SyncRun | null | undefined): ReadonlyMap<string, SyncRepo> {
  return new Map((run?.repos ?? []).map((r) => [r.path, r]));
}
