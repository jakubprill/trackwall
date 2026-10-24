import type { BatchRepo, BatchRun, BatchStep, BatchStepResult } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";
import type { StatusTone } from "./repo-status.ts";

/** Komenda zbiorcza w UI (ADR-27): nazwy kroków, stan kroku w jednej linii i postęp; testy w `test/batch-state.test.ts`. */

export const STEP_LABEL: Record<BatchStep, string> = {
  sync: "Sync",
  tools: "Tools",
  setup: "Dependencies",
  build: "Build",
};

/** Co krok robi w repo; komendę składa daemon (§1.2), UI tylko ją opisuje. */
export const STEP_HINT: Record<BatchStep, string> = {
  sync: "fetch and fast-forward the default branch",
  tools: "mise install: JDK, Node and everything else from the repo's mise config",
  setup: "mise task setup, if the repo has one",
  build: "mise task build, if the repo has one",
};

/** Ton ma to, co trwa albo wymaga uwagi; pominięty i przerwany krok są zwykłym tekstem, jak zatrzymany task mise. */
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

/** Zdanie z daemona dla pominiętego albo nieudanego kroku; pozostałe mieszczą się w krótkim tekście. */
export function stepMessage(step: BatchStepResult): string | undefined {
  return step.state === "skipped" || step.state === "failed" ? step.message : undefined;
}

/** Repo skończyło komendę, gdy żaden jego krok nie czeka ani nie trwa. */
function repoFinished(repo: BatchRepo): boolean {
  return repo.steps.every((s) => s.state !== "waiting" && s.state !== "running");
}

export interface BatchProgress {
  /** Repo, które skończyły komendę (także z błędem albo przerwane). */
  done: number;
  total: number;
  /** Repo z co najmniej jednym nieudanym krokiem. */
  failed: number;
}

export function batchProgress(run: BatchRun): BatchProgress {
  return {
    done: run.repos.filter(repoFinished).length,
    total: run.repos.length,
    failed: run.repos.filter((r) => r.steps.some((s) => s.state === "failed")).length,
  };
}

/** Nagłówek wyników: czy komenda trwa, czy się skończyła, i czy użytkownik ją przerwał. */
export function batchRunLabel(run: BatchRun, now: Date): string {
  if (run.finishedAt === null) return run.cancelled ? "Cancelling" : "Running";
  return `${run.cancelled ? "Cancelled" : "Finished"} ${relativeTime(run.finishedAt, now)}`;
}
