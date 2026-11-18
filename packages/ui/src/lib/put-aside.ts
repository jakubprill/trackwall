import { type BatchRun, countLabel, type PullResult, type PutAside, type StatusLabel } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";
import { pullResultLine } from "./upstream-pull.ts";

/**
 * Putting changes aside to pull (ADR-271): which repos of a batch command can be offered it, and the words for its result
 * and for a put-aside in the Changes tab. The daemon moves only tracked changes into a git stash and brings them back
 * when the pull still cannot move the branch, so nothing here decides what is safe; it only says what happened.
 */

/** The repos of a batch command whose sync was skipped only because of changes in tracked files. */
export function reposSkippedForChanges(run: BatchRun): string[] {
  return run.repos
    .filter((repo) => repo.steps.some((s) => s.step === "sync" && s.state === "skipped" && s.syncReason === "dirty"))
    .map((repo) => repo.repo);
}

/** The pull's line with what was put aside first: "Put aside 3 files · Pulled 41 commits into main". */
export function putAsideResultLine(result: PullResult): StatusLabel {
  const line = pullResultLine(result);
  if (result.putAside === null) return line;
  const count = countLabel(result.putAside.files.length, { one: "file", other: "files" });
  return { ...line, label: `Put aside ${count} · ${line.label}` };
}

/** A put-aside in the Changes tab: "3 files on main, put aside 2 hours ago". */
export function putAsideLabel(putAside: PutAside, now: Date): string {
  const files = countLabel(putAside.files.length, { one: "file", other: "files" });
  const where = putAside.branch === null ? "" : ` on ${putAside.branch}`;
  return `${files}${where}, put aside ${relativeTime(putAside.at, now)}`;
}
