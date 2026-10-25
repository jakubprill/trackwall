import type { BatchRepo, BatchRun, BatchStep, BatchStepResult } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";
import type { StatusTone } from "./repo-status.ts";

/** The batch command in the UI (ADR-27): step names, a step's state in one line and progress; tests in `test/batch-state.test.ts`. */

export const STEP_LABEL: Record<BatchStep, string> = {
  sync: "Sync",
  tools: "Tools",
  setup: "Dependencies",
  build: "Build",
};

/** What a step does in a repo; the daemon builds the command (§1.2), the UI only describes it. */
export const STEP_HINT: Record<BatchStep, string> = {
  sync: "fetch and fast-forward the default branch",
  tools: "mise install: JDK, Node and everything else from the repo's mise config",
  setup: "mise task setup, if the repo has one",
  build: "mise task build, if the repo has one",
};

/** What is running or needs attention has a tone; a skipped or cancelled step is plain text, like a stopped mise task. */
export function stepLabel(step: BatchStepResult): { tone?: StatusTone; label: string } {
  switch (step.state) {
    case "waiting":
      return { label: "waiting" };
    case "running":
      return { tone: "warning", label: "running…" };
    case "done":
      return { tone: "ok", label: step.detail ?? "done" };
    case "skipped":
      return { label: "skipped" };
    case "failed":
      return { tone: "error", label: "failed" };
    case "cancelled":
      return { label: "cancelled" };
  }
}

/** The daemon's sentence for a skipped or failed step; the others fit in the short text. */
export function stepMessage(step: BatchStepResult): string | undefined {
  return step.state === "skipped" || step.state === "failed" ? step.message : undefined;
}

/** A repo has finished the command when none of its steps is waiting or running. */
function repoFinished(repo: BatchRepo): boolean {
  return repo.steps.every((s) => s.state !== "waiting" && s.state !== "running");
}

export interface BatchProgress {
  /** Repos that have finished the command (also with an error or cancelled). */
  done: number;
  total: number;
  /** Repos with at least one failed step. */
  failed: number;
}

export function batchProgress(run: BatchRun): BatchProgress {
  return {
    done: run.repos.filter(repoFinished).length,
    total: run.repos.length,
    failed: run.repos.filter((r) => r.steps.some((s) => s.state === "failed")).length,
  };
}

/** The results header: whether the command is running or has finished, and whether the user cancelled it. */
export function batchRunLabel(run: BatchRun, now: Date): string {
  if (run.finishedAt === null) return run.cancelled ? "Cancelling" : "Running";
  return `${run.cancelled ? "Cancelled" : "Finished"} ${relativeTime(run.finishedAt, now)}`;
}
