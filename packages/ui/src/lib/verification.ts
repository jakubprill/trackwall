import { countLabel, type TestCounts, type TestFailure, type Verification, type VerificationState } from "@trackwall/protocol";
import { formatUptime } from "./format.ts";
import type { StatusTone } from "./repo-status.ts";

/**
 * How the task panel shows a verification (ADR-64): the verdict as a state with a tone, the test counts on one line
 * and a failed test as one name. No React here, so the wording is tested on its own.
 */

/** A running verification is polled more often, so the verdict shows soon after the run ends. */
export function verificationPollMs(verification: Verification | null | undefined): number {
  return verification?.state === "running" ? 1000 : 5000;
}

/**
 * A verdict given before the worktree's files changed (ADR-209), in the words of the task's notice and its row's tooltip:
 * it is about earlier changes, so it is neither a pass nor a failure of the changes as they are now.
 */
export function verificationOutdatedLabel(state: VerificationState): string {
  return `Verification ${state}, but the worktree changed since`;
}

/** The verdict next to the section's title; an outdated one without the colour of a pass or a failure. */
export function verificationLabel(verification: Verification): { tone?: StatusTone; label: string } {
  if (verification.outdated) return { label: `${verification.state} · outdated` };
  switch (verification.state) {
    case "running":
      return { tone: "warning", label: "running" };
    case "passed":
      return { tone: "ok", label: "passed" };
    case "failed":
      return { tone: "error", label: "failed" };
    case "cancelled":
      return { label: "cancelled" };
  }
}

/** `128 tests · 2 failed · 1 error · 3 skipped`, leaving out the counts that are zero. */
export function testCountsLabel(totals: TestCounts): string {
  const parts = [countLabel(totals.tests, { one: "test", other: "tests" })];
  if (totals.failures > 0) parts.push(`${totals.failures} failed`);
  if (totals.errors > 0) parts.push(countLabel(totals.errors, { one: "error", other: "errors" }));
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
  return parts.join(" · ");
}

/** How long the run took, from its start to its end; `null` while it runs. */
export function verificationDuration(verification: Verification): string | null {
  if (verification.finishedAt === null) return null;
  return formatUptime(Math.max(0, Date.parse(verification.finishedAt) - Date.parse(verification.startedAt)));
}

/** A Java class with its package (`shop.cart.CartTest`); a jest or Vitest suite is a file (`cart.test.ts`) or a title instead. */
const QUALIFIED_CLASS = /^([a-z_$][\w$]*\.)+[A-Z][\w$]*$/;

/** A failed test as the user finds it in the code: the class without its package (or the suite), then the test name. */
export function failedTestName(failure: TestFailure): string {
  const owner = failure.className ?? failure.suite;
  const shortOwner = QUALIFIED_CLASS.test(owner) ? owner.slice(owner.lastIndexOf(".") + 1) : owner;
  return shortOwner === "" || shortOwner === failure.name ? failure.name : `${shortOwner} › ${failure.name}`;
}
