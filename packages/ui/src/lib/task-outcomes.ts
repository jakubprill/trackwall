import { type FollowedMergeRequest, mergeRequestNumber, type TaskOutcome, type VerificationState } from "@trackwall/protocol";
import { failedJobNames, mergeRequestStateLabel, mergeRequestStatus, pipelineLabel } from "./merge-request.ts";
import type { StatusTone } from "./repo-status.ts";
import { type BrowserNotice, TAG_PREFIX } from "./tab-attention.ts";
import { verificationOutdatedLabel } from "./verification.ts";

/**
 * What a task's work came to, at a glance (ADR-154): the marks on its row in the Sessions list, and the notification
 * of a pipeline that failed, which a browser tab shows with the desktop shell's words (`notification.rs`). The daemon
 * decides when a pipeline failed (`pipelineFailedAt`); here only a new value of it counts. No React here, so the wording
 * is tested on its own.
 */

/** One mark on a task's row: a word or a number with a tone, and the whole story as its tooltip. */
export interface OutcomeMark {
  key: "review" | "verification" | "merge-request";
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

/** An outdated verdict (ADR-209) says so, without the colour of a pass or a failure of the changes as they are now. */
function verificationMark(state: VerificationState, outdated: boolean): Omit<OutcomeMark, "key"> {
  if (!outdated) return VERIFICATION_MARK[state];
  return { label: "Verify outdated", title: verificationOutdatedLabel(state) };
}

/** A task whose agent handed its work over (ADR-212), until the user gives it work again. */
const IN_REVIEW_MARK: OutcomeMark = {
  key: "review",
  label: "In review",
  title: "The agent handed its work over for your review; a review or a Fix gives it work again",
};

/**
 * "In review" first when the agent handed its work over, then the verdict, then the merge request: `!12` with the
 * pipeline's tone while it is open, the merge request's own once merged or closed.
 */
export function outcomeMarks(outcome: TaskOutcome | undefined, inReview: boolean): OutcomeMark[] {
  const marks: OutcomeMark[] = inReview ? [IN_REVIEW_MARK] : [];
  if (!outcome) return marks;
  if (outcome.verification) marks.push({ key: "verification", ...verificationMark(outcome.verification, outcome.verificationOutdated) });
  const mr = outcome.mergeRequest;
  if (mr)
    marks.push({
      key: "merge-request",
      tone: mergeRequestStatus(mr).tone,
      label: mergeRequestNumber(mr.project, mr.number),
      title: mergeRequestTitle(mr),
    });
  return marks;
}

/** `!12 Add a discount · open · pipeline failed: unit-tests, lint`. */
function mergeRequestTitle(mr: FollowedMergeRequest): string {
  const parts = [`${mergeRequestNumber(mr.project, mr.number)} ${mr.title}`, mergeRequestStateLabel(mr.state).label];
  const jobs = failedJobNames(mr);
  if (mr.pipeline) parts.push(`${pipelineLabel(mr.pipeline.state).label}${jobs ? `: ${jobs}` : ""}`);
  return parts.join(" · ");
}

/** "Pipeline failed in orders-api", as the shell's notification says it; clicking it opens the task. */
function pipelineNotice(outcome: TaskOutcome & { mergeRequest: FollowedMergeRequest }): BrowserNotice {
  const mr = outcome.mergeRequest;
  const jobs = failedJobNames(mr);
  const failed = jobs ? `\nFailed: ${jobs}` : "";
  return {
    title: `Pipeline failed in ${outcome.repo}`,
    body: `${mergeRequestNumber(mr.project, mr.number)} ${mr.title}${failed}`,
    tag: `${TAG_PREFIX}pipeline:${outcome.task}`,
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
