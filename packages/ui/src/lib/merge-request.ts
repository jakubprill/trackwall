import {
  countLabel,
  cutText,
  type HostedProject,
  JOB_LOG_LINES_MAX,
  type JobLog,
  MERGE_REQUEST_DESCRIPTION_MAX,
  MERGE_REQUEST_TITLE_MAX,
  type MergeRequest,
  type MergeRequestForm,
  type MergeRequestState,
  type PipelineState,
  pipelineStateText,
  type Task,
  type TaskBranchPush,
  type Verification,
} from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";
import { testCountsLabel } from "./verification.ts";

/**
 * How the task panel shows a task's way to a merge request (ADR-77): the draft the user approves for the repo host's
 * form, the branch against the remote in one line, and the merge request and pipeline states with a tone. No React here,
 * so the wording is tested on its own.
 */

/** The repo host does not change while the panel is open; a pipeline takes minutes. */
export const MERGE_REQUEST_POLL_MS = 30_000;

export type MergeRequestDraftText = Pick<MergeRequestForm, "title" | "description">;

/**
 * The draft of the form: the task's title (or the first line of its prompt) and the agent's summary (or the prompt)
 * with its check steps (ADR-169) and the verdict of the last verification, so the reviewer sees what the user saw and
 * can try the change the same way. A part of a change starts with its change block (ADR-172), which a long summary is
 * cut to make room for, so the reviewer always sees the other repos.
 */
export function mergeRequestDraft(task: Task, verification: Verification | null, changeBlock: string | null): MergeRequestDraftText {
  const title = (task.title ?? task.prompt.split("\n", 1)[0] ?? "").trim();
  const body = (task.summary?.text ?? task.prompt).trim();
  const checks = task.summary && task.summary.checkSteps.length > 0 ? `\n\n${checkStepsSection(task.summary.checkSteps)}` : "";
  const verdict = verification && verification.state !== "running" ? `\n\n${verificationLine(verification)}` : "";
  return {
    title: cutText(title, MERGE_REQUEST_TITLE_MAX),
    description: withBlock(changeBlock, `${body}${checks}${verdict}`),
  };
}

function withBlock(block: string | null, rest: string): string {
  if (block === null) return cutText(rest, MERGE_REQUEST_DESCRIPTION_MAX);
  const separator = "\n\n";
  const room = MERGE_REQUEST_DESCRIPTION_MAX - block.length - separator.length;
  // Six parts with long addresses still leave room; a block that does not is cut like any text.
  if (room < 1) return cutText(block, MERGE_REQUEST_DESCRIPTION_MAX);
  return `${block}${separator}${cutText(rest, room)}`;
}

/** `How to check:` and the steps as a numbered Markdown list, which GitLab and GitHub both render. */
function checkStepsSection(steps: readonly string[]): string {
  return ["How to check:", ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n");
}

/** `Verification in Trackwall: passed (mise task test, 128 tests · 3 skipped)`. */
function verificationLine(verification: Verification): string {
  const tests = verification.tests && verification.tests.reports > 0 ? `, ${testCountsLabel(verification.tests.totals)}` : "";
  return `Verification in Trackwall: ${verification.state} (mise task ${verification.miseTask}${tests})`;
}

/** `2 commits · 1 not pushed · 3 files not committed`, or the warning that the remote moved on. */
export function branchPushLabel(push: TaskBranchPush): string {
  const parts = [countLabel(push.commits, { one: "commit", other: "commits" })];
  if (!push.published) parts.push("not pushed yet");
  else if (push.unpushed > 0) parts.push(`${push.unpushed} not pushed`);
  else parts.push("pushed");
  if (push.behind > 0) parts.push(`the remote has ${countLabel(push.behind, { one: "commit", other: "commits" })} the task does not`);
  if (push.uncommitted > 0) parts.push(`${countLabel(push.uncommitted, { one: "file", other: "files" })} not committed`);
  return parts.join(" · ");
}

/** Whether "Push" has anything to send: commits, and some the remote does not have. */
export function canPush(push: TaskBranchPush): boolean {
  return push.commits > 0 && (!push.published || push.unpushed > 0);
}

/** The name of the repo host in the form's button. */
export function hostLabel(project: HostedProject): string {
  return project.kind === "gitlab" ? "GitLab" : "GitHub";
}

export function mergeRequestStateLabel(state: MergeRequestState): { tone?: StatusTone; label: string } {
  switch (state) {
    case "open":
      return { tone: "warning", label: "open" };
    case "merged":
      return { tone: "ok", label: "merged" };
    case "closed":
      return { label: "closed" };
  }
}

/** A merge request in one tone and label: its pipeline's while it is open, its own once merged or closed (ADR-154). */
export function mergeRequestStatus(mergeRequest: MergeRequest): { tone?: StatusTone; label: string } {
  const { state, pipeline } = mergeRequest;
  return state === "open" && pipeline ? pipelineLabel(pipeline.state) : mergeRequestStateLabel(state);
}

/** `unit-tests, lint`: the jobs that failed the pipeline; empty when it names none. */
export function failedJobNames(mergeRequest: MergeRequest): string {
  return (mergeRequest.pipeline?.failedJobs ?? []).map((job) => job.name).join(", ");
}

/** "Fix" asks the task's agent to fix a pipeline only while it failed on an open merge request (ADR-195). */
export function canFixPipeline(mergeRequest: MergeRequest): boolean {
  return mergeRequest.state === "open" && mergeRequest.pipeline?.state === "failed";
}

/** What a job's log excerpt leaves out, in words; `null` when it is the whole log. */
export function jobLogNote(log: JobLog): string | null {
  if (!log.truncated) return null;
  if (log.text === "") return "The log is too long for Trackwall to read its end: open the job's page.";
  return `The last ${JOB_LOG_LINES_MAX} lines at most: the job's page has the whole log.`;
}

export function pipelineLabel(state: PipelineState): { tone?: StatusTone; label: string } {
  const tone = pipelineTone(state);
  return tone === undefined ? { label: pipelineStateText(state) } : { tone, label: pipelineStateText(state) };
}

function pipelineTone(state: PipelineState): StatusTone | undefined {
  switch (state) {
    case "passed":
      return "ok";
    case "failed":
      return "error";
    case "running":
    case "pending":
    case "manual":
      return "warning";
    case "cancelled":
    case "skipped":
      return undefined;
  }
}
