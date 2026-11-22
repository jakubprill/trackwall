import { type RepoStatus, type RepoStatusOk, type StatusTone, trackedChanges } from "@trackwall/protocol";
import { workingTreeLabel } from "./format.ts";

export type { StatusTone };

/**
 * A repo's state in one line (§4.5): the dot tone and the text next to it. One place for the rule
 * "unavailable = error, working directory changes = warning, clean = ok" for the repo header and, under `repoListTone`,
 * the repo list.
 */
export function repoStatusTone(status: RepoStatus): { tone?: StatusTone; label: string } {
  // No tone while the status is on its way (ADR-113): a dot would claim a state the view does not know yet.
  if (status.kind === "loading") return { label: "loading" };
  if (status.kind !== "ok") return { tone: "error", label: "unavailable" };
  const changes = workingTreeLabel(trackedChanges(status), status.untracked);
  return changes ? { tone: "warning", label: changes } : { tone: "ok", label: "clean" };
}

/**
 * A repo's state in the repo list (ADR-293): the working directory as `repoStatusTone` says it, then what its branch lacks
 * from the branch it tracks (`serverLabel`), so a clean repo with commits to pull no longer reads "clean".
 */
export function repoListTone(status: RepoStatus, newOnServer: boolean): { tone?: StatusTone; label: string } {
  const own = repoStatusTone(status);
  const server = status.kind === "ok" ? serverLabel(status, newOnServer) : null;
  if (server === null) return own;
  return { tone: "warning", label: own.tone === "ok" ? server : `${own.label} · ${server}` };
}

/** What a repo reads while only the server check knows of commits it has not fetched (ADR-295). */
export const NEW_ON_SERVER = "new on the server";

/**
 * What the checked-out branch lacks from the branch it tracks: as of the last fetch "15 to pull", or "diverged" when it
 * also has commits of its own, which no pull moves; otherwise "new on the server" when the server check found commits
 * the last fetch did not bring (`newOnServer`, ADR-295), which a fetch counts; `null` when it lacks nothing or tracks no
 * branch.
 */
export function serverLabel(status: RepoStatusOk, newOnServer: boolean): string | null {
  const { upstream } = status;
  if (upstream === null) return null;
  if (upstream.behind > 0) return upstream.ahead > 0 ? "diverged" : `${upstream.behind} to pull`;
  return newOnServer ? NEW_ON_SERVER : null;
}

/** The "Changes" tab of one repo: the user's uncommitted work, which no event reports. */
export const WORKING_TREE_POLL_MS = 10_000;

/**
 * The repo list does not exist until the projects folder is fixed in the settings: it disappeared or is wrong in
 * `workspace.yaml`. An old list would then look current, so the views do not show it.
 */
export function listNeedsSettings(errorCode: string | undefined): boolean {
  return errorCode === "projects_dir_unavailable" || errorCode === "invalid_config";
}

export function branchLabel(status: RepoStatusOk): string {
  return status.branch ?? "detached HEAD";
}
