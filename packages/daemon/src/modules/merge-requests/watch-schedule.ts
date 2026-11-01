import type { HostedProject, MergeRequest } from "@trackwall/protocol";

/**
 * When the daemon reads a task's merge request again while following it in the background (ADR-154, §4.12), and when
 * what it read is a new pipeline failure. Pure, so the rules are tested on their own.
 */

/** A pipeline that runs is read every minute: a failure shows about a minute after the job ends. */
export const ACTIVE_CHECK_MS = 60_000;
/** A settled pipeline, a branch without a merge request yet or a repo host that did not answer: a new push or a merge request made elsewhere shows within minutes. */
export const SETTLED_CHECK_MS = 5 * 60_000;
/** A merged or closed merge request rarely changes again; reopening one shows within a quarter of an hour. */
export const DONE_CHECK_MS = 15 * 60_000;

/**
 * What one read found: the merge request from the task branch; `none`, also for a branch not published yet; or
 * `unknown` when the repo host could not be asked (not one from the settings, or `gh`/`glab` did not answer).
 */
export type WatchRead = { kind: "found"; mergeRequest: MergeRequest; project: HostedProject } | { kind: "none" } | { kind: "unknown" };

export function nextCheckMs(read: WatchRead): number {
  if (read.kind !== "found") return SETTLED_CHECK_MS;
  const { state, pipeline } = read.mergeRequest;
  if (state !== "open") return DONE_CHECK_MS;
  return pipeline?.state === "pending" || pipeline?.state === "running" ? ACTIVE_CHECK_MS : SETTLED_CHECK_MS;
}

/**
 * Whether `current`'s pipeline failed since the read before: it is `failed` now, and before it was in another state, on
 * another commit, of another merge request, or there was none. `previous` is `undefined` when the daemon has not read
 * the task's merge request since it started; a pipeline already failed then is not new, so a restart does not announce
 * old failures again.
 */
export function pipelineFailedNow(previous: MergeRequest | null | undefined, current: MergeRequest | null): boolean {
  const now = current?.pipeline;
  if (!current || now?.state !== "failed" || previous === undefined) return false;
  const before = previous?.number === current.number ? previous.pipeline : null;
  return before?.state !== "failed" || before.commit !== now.commit;
}
