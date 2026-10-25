import { type RepoStatus, type RepoStatusOk, trackedChanges } from "@trackwall/protocol";
import { workingTreeLabel } from "./format.ts";

/** A state's tone in the UI; `lib/status-tone.ts` picks the colour for a tone, and the tokens are in `index.css` (ADR-16). */
export type StatusTone = "ok" | "warning" | "error";

/**
 * A repo's state in one line (§4.5): the dot tone and the text next to it. One place for the rule
 * "unavailable = error, working directory changes = warning, clean = ok" for the list and the repo header.
 */
export function repoStatusTone(status: RepoStatus): { tone: StatusTone; label: string } {
  if (status.kind !== "ok") return { tone: "error", label: "unavailable" };
  const changes = workingTreeLabel(trackedChanges(status), status.untracked);
  return changes ? { tone: "warning", label: changes } : { tone: "ok", label: "clean" };
}

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
