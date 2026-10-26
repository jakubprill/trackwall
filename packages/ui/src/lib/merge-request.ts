import {
  countLabel,
  type HostedProject,
  MERGE_REQUEST_DESCRIPTION_MAX,
  MERGE_REQUEST_TITLE_MAX,
  type MergeRequestForm,
  type MergeRequestState,
  type PipelineState,
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
 * with the verdict of the last verification, so the reviewer sees what the user saw.
 */
export function mergeRequestDraft(task: Task, verification: Verification | null): MergeRequestDraftText {
  const title = (task.title ?? task.prompt.split("\n", 1)[0] ?? "").trim();
  const body = (task.summary?.text ?? task.prompt).trim();
  const verdict = verification && verification.state !== "running" ? `\n\n${verificationLine(verification)}` : "";
  return {
    title: cut(title, MERGE_REQUEST_TITLE_MAX),
    description: cut(`${body}${verdict}`, MERGE_REQUEST_DESCRIPTION_MAX),
  };
}

/** `Verification in Trackwall: passed (mise task test, 128 tests · 3 skipped)`. */
function verificationLine(verification: Verification): string {
  const tests = verification.tests && verification.tests.reports > 0 ? `, ${testCountsLabel(verification.tests.totals)}` : "";
  return `Verification in Trackwall: ${verification.state} (mise task ${verification.miseTask}${tests})`;
}

/** By code points, so a cut never splits an emoji; the daemon's limits count UTF-16 units, which is never fewer. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  let kept = "";
  for (const char of chars) {
    if (kept.length + char.length > max - 1) break;
    kept += char;
  }
  return `${kept}…`;
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

/** `!12` on GitLab, `#12` on GitHub, as each host writes it. */
export function mergeRequestNumber(project: HostedProject, number: number): string {
  return `${project.kind === "gitlab" ? "!" : "#"}${number}`;
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

export function pipelineLabel(state: PipelineState): { tone?: StatusTone; label: string } {
  switch (state) {
    case "passed":
      return { tone: "ok", label: "pipeline passed" };
    case "failed":
      return { tone: "error", label: "pipeline failed" };
    case "running":
      return { tone: "warning", label: "pipeline running" };
    case "pending":
      return { tone: "warning", label: "pipeline pending" };
    case "manual":
      return { tone: "warning", label: "pipeline waits for a manual job" };
    case "cancelled":
      return { label: "pipeline cancelled" };
    case "skipped":
      return { label: "pipeline skipped" };
  }
}
