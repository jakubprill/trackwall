import { countLabel, type TestFix, type Verification } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * The test fix the user asks for from a verification (ADR-302): one failed test it kept, by its index, or all of them
 * (`failure` `null`), with how many other tests failed, so the agent knows the list is not the whole story. Only the
 * daemon's own copy of the verification is the source: the request names a test by index, never by its text.
 */
export function testFixOf(verification: Verification, failure: number | null): TestFix {
  const { failures, tests, runId, outdated } = verification;
  if (verification.state !== "failed" || failures.length === 0)
    throw new DomainError("bad_request", `the last verification of task ${verification.task} has no failed test to fix`);
  const picked = failure === null ? failures : failures.slice(failure, failure + 1);
  if (picked.length === 0)
    throw new DomainError(
      "bad_request",
      `the last verification of task ${verification.task} kept only ${countLabel(failures.length, { one: "failed test", other: "failed tests" })}`,
    );
  const failed = tests ? tests.totals.failures + tests.totals.errors : failures.length;
  return { runId, outdated, failures: picked, otherFailures: Math.max(0, failed - picked.length) };
}
