import type { ReproductionCheck, ReproductionPhase, ReproductionRun, ReproTest } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * How the task panel shows a reproduction check (ADR-227) under the agent's reproduction test: the verdict with a tone,
 * what each run found, and whether the check is about the test the agent names now. No React here, so the wording is
 * tested on its own.
 */

/** A running check is polled more often, so its phases and verdict show soon after they change. */
export function reproductionPollMs(check: ReproductionCheck | null | undefined): number {
  return check?.state === "running" ? 1000 : 10_000;
}

const PHASE: Record<ReproductionPhase, string> = {
  copy: "copying the repo at the task's base",
  base: "running the test without the fix",
  change: "running the test with the task's changes",
};

/** The verdict in a few words; Trackwall's own, so it says so. */
export function reproductionLabel(check: ReproductionCheck): { tone?: StatusTone; label: string } {
  switch (check.state) {
    case "running":
      return { tone: "warning", label: `checking: ${PHASE[check.phase ?? "copy"]}` };
    case "reproduced":
      return { tone: "ok", label: "checked by Trackwall: fails without the fix, passes with it" };
    case "not_reproduced":
      return { tone: "error", label: "not reproduced" };
    case "inconclusive":
      return { label: "check inconclusive" };
    case "cancelled":
      return { label: "check stopped" };
  }
}

/** What each run found, `Without the fix: failed (Type: message) · With the fix: passed`; empty before the first run ends. */
export function reproductionRunsLine(check: ReproductionCheck): string {
  const parts = [
    check.base && `Without the fix: ${runLabel(check.base)}`,
    check.change && `With the fix: ${runLabel(check.change)}`,
  ].filter((part) => part !== null);
  return parts.join(" · ");
}

function runLabel(run: ReproductionRun): string {
  const outcome = run.outcome === "missing" ? "not in the test reports" : run.outcome;
  const failure = run.failure && [run.failure.type, run.failure.message].filter((text) => text !== null).join(": ");
  return failure ? `${outcome} (${failure})` : outcome;
}

/** A line for a check that ran every test of the repo, since its mise task `test` takes no filter (ADR-158). */
export function reproductionFilterNote(check: ReproductionCheck): string | null {
  const ran = check.base !== null;
  return ran && check.filter === null ? "The repo's test task takes no filter, so every test ran." : null;
}

/** Whether the check is about the test the agent names now: a later report may name another one. */
export function checksTest(check: ReproductionCheck, test: ReproTest): boolean {
  return check.test.file === test.file && check.test.name === test.name;
}

/**
 * The check to show under the agent's test: one of this test, or one of an earlier test while it runs, so it can still
 * be stopped (a new check starts only once it has ended); `null` for a finished check of an earlier test.
 */
export function shownCheck(check: ReproductionCheck | null, test: ReproTest): ReproductionCheck | null {
  return check && (check.state === "running" || checksTest(check, test)) ? check : null;
}
