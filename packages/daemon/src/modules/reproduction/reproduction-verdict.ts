import type { ReproductionRun, ReproductionState } from "@trackwall/protocol";

/**
 * The verdict of a reproduction check (ADR-227) from its two runs: the test must fail on the base, where the task's test
 * files are the only change, and pass with all of the task's changes. Anything else is said in one sentence.
 */
export function reproductionVerdict(
  base: ReproductionRun,
  change: ReproductionRun | null,
): { state: Exclude<ReproductionState, "running" | "cancelled">; message: string | null } {
  if (base.outcome === "missing")
    return {
      state: "inconclusive",
      message:
        "the test did not run on the base: the run's reports do not have it, so it may not compile without the fix (see the run's log)",
    };
  if (base.outcome === "skipped") return { state: "inconclusive", message: "the test was skipped on the base" };
  if (base.outcome === "passed")
    return { state: "not_reproduced", message: "the test passed on the base without the fix, so it does not show the error" };
  if (change === null) return { state: "inconclusive", message: "the test was not run with the change" };
  if (change.outcome === "missing")
    return { state: "inconclusive", message: "the test did not run with the change: the run's reports do not have it (see the run's log)" };
  if (change.outcome === "skipped") return { state: "inconclusive", message: "the test was skipped with the change" };
  if (change.outcome === "failed") return { state: "not_reproduced", message: "the test still fails with the change" };
  return { state: "reproduced", message: null };
}

/** Whether the change run is worth its minutes: only after the test failed on the base. */
export function needsChangeRun(base: ReproductionRun): boolean {
  return base.outcome === "failed";
}
