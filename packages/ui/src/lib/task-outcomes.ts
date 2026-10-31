import type { FollowedMergeRequest, TaskOutcome, VerificationState } from "@trackwall/protocol";
import { mergeRequestNumber, mergeRequestStateLabel, pipelineLabel } from "./merge-request.ts";
import type { StatusTone } from "./repo-status.ts";
import type { BrowserNotice } from "./tab-attention.ts";

/**
 * What a task's work came to, at a glance (ADR-154): the marks on its row in the Sessions list, and the notification
 * of a pipeline that failed, which a browser tab shows with the desktop shell's words (`notification.rs`). The daemon
 * decides when a pipeline failed (`pipelineFailedAt`); here only a new value of it counts. No React here, so the wording
 * is tested on its own.
 */

/** One mark on a task's row: a word or a number with a tone, and the whole story as its tooltip. */
export interface OutcomeMark {
  key: "verification" | "merge-request";
  tone?: StatusTone;
  label: string;
  title: string;
}

const VERIFICATION_MARK: Record<VerificationState, { tone?: StatusTone; label: string; title: string }> = {
  running: { tone: "warning", label: "Verifying", title: "Verification running" },
  passed: { tone: "ok", label: "Verified", title: "Verification passed" },
  failed: { tone: "error", label: "Verify failed", title: "Verification failed" },
  cancelled: { label: "Verify cancelled", title: "Verification cancelled" },
};

/** The verdict first, then the merge request: `!12` with the pipeline's tone while it is open, the merge request's own once merged or closed. */
export function outcomeMarks(outcome: TaskOutcome | undefined): OutcomeMark[] {
  if (!outcome) return [];
  const marks: OutcomeMark[] = [];
  if (outcome.verification) marks.push({ key: "verification", ...VERIFICATION_MARK[outcome.verification] });
  const mr = outcome.mergeRequest;
  if (mr)
    marks.push({
      key: "merge-request",
      tone: mergeRequestTone(mr),
      label: mergeRequestNumber(mr.project, mr.number),
      title: mergeRequestTitle(mr),
    });
  return marks;
}

function mergeRequestTone(mr: FollowedMergeRequest): StatusTone | undefined {
  if (mr.state !== "open" || !mr.pipeline) return mergeRequestStateLabel(mr.state).tone;
  return pipelineLabel(mr.pipeline.state).tone;
}

/** `!12 Add a discount · open · pipeline failed: unit-tests, lint`. */
function mergeRequestTitle(mr: FollowedMergeRequest): string {
  const parts = [`${mergeRequestNumber(mr.project, mr.number)} ${mr.title}`, mergeRequestStateLabel(mr.state).label];
  if (mr.pipeline) parts.push(`${pipelineLabel(mr.pipeline.state).label}${failedJobsText(mr)}`);
  return parts.join(" · ");
}

/** `: unit-tests, lint` after a failed pipeline that names its failed jobs; nothing otherwise. */
function failedJobsText(mr: FollowedMergeRequest): string {
  const jobs = mr.pipeline?.failedJobs ?? [];
  return jobs.length > 0 ? `: ${jobs.map((j) => j.name).join(", ")}` : "";
}

/** "Pipeline failed in orders-api", as the shell's notification says it; clicking it opens the task. */
function pipelineNotice(outcome: TaskOutcome & { mergeRequest: FollowedMergeRequest }): BrowserNotice {
  const mr = outcome.mergeRequest;
  const jobs = mr.pipeline?.failedJobs ?? [];
  const failed = jobs.length > 0 ? `\nFailed: ${jobs.map((j) => j.name).join(", ")}` : "";
  return {
    title: `Pipeline failed in ${outcome.repo}`,
    body: `${mergeRequestNumber(mr.project, mr.number)} ${mr.title}${failed}`,
    tag: `trackwall:pipeline:${outcome.task}`,
    target: { kind: "task", id: outcome.task },
  };
}

/**
 * The pipelines that failed since the list before, one list after another. At the first list nothing is new, like a
 * session already waiting when the page opened: the row shows it, a notification would only repeat it.
 */
export class PipelineFailures {
  #seen: ReadonlyMap<string, string | null> | undefined;

  next(outcomes: readonly TaskOutcome[]): BrowserNotice[] {
    const before = this.#seen;
    this.#seen = new Map(outcomes.map((o) => [o.task, o.mergeRequest?.pipelineFailedAt ?? null]));
    if (!before) return [];
    return outcomes.flatMap((o) => {
      const { mergeRequest } = o;
      const failedAt = mergeRequest?.pipelineFailedAt ?? null;
      return mergeRequest && failedAt !== null && before.get(o.task) !== failedAt ? [pipelineNotice({ ...o, mergeRequest })] : [];
    });
  }
}
