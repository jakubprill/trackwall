import {
  type AutoReview,
  type AutoReviewSeverity,
  type ChangedFile,
  countLabel,
  modelSwitch,
  otherAttempts,
  type Session,
  type Task,
} from "@trackwall/protocol";
import { errorMessage } from "./api.ts";
import { typedModel } from "./task-model.ts";

/**
 * Two attempts at one task side by side (ADR-251): a task and its retry (ADR-233) start from the same prompt and base
 * commit, so what they did differently is their work. No React here, so what the "Compare" tab says is tested on its own.
 */

/** The attempt the "Compare" tab shows next to `task`: the one the user picked while it is listed, else the newest other. */
export function comparedAttempt(task: Task, tasks: readonly Task[], picked: string | null): Task | undefined {
  const others = otherAttempts(task, tasks);
  return others.find((t) => t.id === picked) ?? newest(others);
}

function newest(tasks: readonly Task[]): Task | undefined {
  return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The model an attempt asked for, and the one Copilot CLI runs it on when that differs (ADR-225). */
export function attemptModel(task: Task, session: Session | undefined): { asked: string; runsOn: string | null } {
  const asked = task.model ?? "Copilot CLI default";
  const switched = session ? modelSwitch(session) : null;
  return { asked, runsOn: switched?.inUse ?? null };
}

/** One changed file of either attempt, with what each of them did to it; `null` on the side that left it alone. */
export interface ComparedFile {
  path: string;
  left: ChangedFile | null;
  right: ChangedFile | null;
}

/** The files either attempt changed, by path, each once. */
export function comparedFiles(left: readonly ChangedFile[], right: readonly ChangedFile[]): ComparedFile[] {
  const paths = [...new Set([...left, ...right].map((f) => f.path))].sort((a, b) => a.localeCompare(b));
  return paths.map((path) => ({
    path,
    left: left.find((f) => f.path === path) ?? null,
    right: right.find((f) => f.path === path) ?? null,
  }));
}

/** "3 files · +40 −2"; lines of binary files are not counted. */
export function changeTotals(files: readonly ChangedFile[]): string {
  const added = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  if (files.length === 0) return "no changes";
  return `${countLabel(files.length, { one: "file", other: "files" })} · +${added} −${removed}`;
}

/** What one side did to a file, for the file list: "+12 −3", "binary", or "–" when it left the file alone. */
export function fileChangeLabel(file: ChangedFile | null): string {
  if (file === null) return "–";
  if (file.additions === null) return file.change === "deleted" ? "deleted" : "binary";
  const counts = `+${file.additions} −${file.deletions}`;
  return file.change === "modified" ? counts : `${file.change} ${counts}`;
}

const SEVERITY_ORDER: readonly AutoReviewSeverity[] = ["critical", "high", "medium", "low"];

/**
 * The automatic code review (ADR-182) of an attempt in a few words: "not run", "running", "no findings", "2 findings ·
 * 1 high" (the worst severity, which the user weighs first), "failed" or "cancelled".
 */
export function reviewLabel(review: AutoReview | null): string {
  if (review === null) return "not run";
  if (review.state !== "done") return review.state;
  const { findings } = review;
  if (findings.length === 0) return "no findings";
  const count = countLabel(findings.length, { one: "finding", other: "findings" });
  const worst = SEVERITY_ORDER.find((s) => findings.some((f) => f.severity === s));
  return worst === undefined ? count : `${count} · ${findings.filter((f) => f.severity === worst).length} ${worst}`;
}

/**
 * The model of the second attempt a new task starts with (ADR-251): the one typed for it, or with an empty field the
 * task's own model, so the two attempts are two runs of one model. `undefined` for text that is no model id, which
 * holds the start until the user fixes it, as for the task's own model.
 */
export function secondAttemptModel(typed: string, taskModel: string | null): string | null | undefined {
  const model = typedModel(typed);
  return model === null ? taskModel : model;
}

/**
 * A new task and, right after it, its second attempt (a retry from the same commit, ADR-233). The task stands even when
 * the second attempt does not start, so that failure is said (`secondProblem`) rather than thrown: a second press would
 * start the task again.
 */
export async function startTwoAttempts(
  create: () => Promise<Task>,
  retry: (task: Task) => Promise<Task>,
): Promise<{ task: Task; secondProblem: string | null }> {
  const task = await create();
  try {
    await retry(task);
    return { task, secondProblem: null };
  } catch (err) {
    return { task, secondProblem: `The task started, but its second attempt did not: ${errorMessage(err)}` };
  }
}
