import type { TestCounts } from "@trackwall/protocol";
import { parseXml, type XmlElement } from "../../infra/xml.ts";

/**
 * One JUnit XML report (ADR-60): the de facto format of Surefire, Gradle, Ant, jest-junit and Vitest, with
 * `<testsuites>` or a single `<testsuite>` as the root, suites nested in suites, and `<testcase>` elements with a
 * `<failure>`, `<error>` or `<skipped>` child. The counts come from the test cases, not from the suite attributes,
 * which some tools leave out. Every `<testcase>` counts, also a repeated one: jest and Vitest repeat titles for real,
 * different tests, so merging them could hide a failure, at the cost that every attempt of Gradle's test-retry plugin
 * counts as well. The text is as the report has it: limiting and masking it for an agent is the caller's job.
 */

/** A failed test as the report has it. */
export interface ReportFailure {
  suite: string;
  className: string | null;
  name: string;
  kind: "failure" | "error";
  type: string | null;
  message: string | null;
  /** The whole text of the `<failure>` or `<error>` element, usually the stack trace. */
  stack: string;
  timeSeconds: number | null;
}

/** Any test case by its name and outcome, for a reproduction check that looks for one test (ADR-227). */
export interface ReportCase {
  suite: string;
  className: string | null;
  name: string;
  kind: "passed" | "skipped" | "failure" | "error";
  type: string | null;
  message: string | null;
}

export interface JunitReport {
  counts: TestCounts;
  failures: ReportFailure[];
  /** Every test case in report order. */
  cases: ReportCase[];
}

type CaseNames = { suite: string; className: string | null; name: string; timeSeconds: number | null };
type Outcome = ({ kind: "passed" } & CaseNames) | ({ kind: "skipped" } & CaseNames) | ReportFailure;

/** Which count a failed test case adds to. */
const FAILED_COUNT = { failure: "failures", error: "errors" } as const;

export function emptyCounts(): TestCounts {
  return { tests: 0, failures: 0, errors: 0, skipped: 0, timeSeconds: null };
}

/** Adds `more` to `counts`; times are summed to milliseconds, the precision of the reports, so `0.1 + 0.2` is `0.3`. */
export function addCounts(counts: TestCounts, more: TestCounts): void {
  counts.tests += more.tests;
  counts.failures += more.failures;
  counts.errors += more.errors;
  counts.skipped += more.skipped;
  if (more.timeSeconds !== null) counts.timeSeconds = Math.round(((counts.timeSeconds ?? 0) + more.timeSeconds) * 1000) / 1000;
}

/** Throws when the text is not XML or its root is not a JUnit test suite. */
export function parseJunitReport(text: string): JunitReport {
  const root = parseXml(text);
  if (root.name !== "testsuites" && root.name !== "testsuite") throw new Error(`the root element is <${root.name}>, not <testsuite>`);
  const outcomes: Outcome[] = [];
  collectSuite(root, outcomes);
  const report: JunitReport = { counts: emptyCounts(), failures: [], cases: [] };
  for (const outcome of outcomes) {
    report.cases.push(caseOf(outcome));
    const counts: TestCounts = { ...emptyCounts(), tests: 1, timeSeconds: outcome.timeSeconds };
    if (outcome.kind === "skipped") counts.skipped = 1;
    else if (outcome.kind !== "passed") {
      counts[FAILED_COUNT[outcome.kind]] = 1;
      report.failures.push(outcome);
    }
    addCounts(report.counts, counts);
  }
  return report;
}

function collectSuite(suite: XmlElement, outcomes: Outcome[]): void {
  const name = suite.attributes.get("name") ?? "";
  for (const child of suite.children) {
    if (child.name === "testsuite") collectSuite(child, outcomes);
    else if (child.name === "testcase") outcomes.push(outcomeOf(child, name));
  }
}

function caseOf(outcome: Outcome): ReportCase {
  const { suite, className, name } = outcome;
  if (outcome.kind === "passed" || outcome.kind === "skipped")
    return { suite, className, name, kind: outcome.kind, type: null, message: null };
  return { suite, className, name, kind: outcome.kind, type: outcome.type, message: outcome.message };
}

function outcomeOf(testCase: XmlElement, suite: string): Outcome {
  const timeSeconds = seconds(testCase.attributes.get("time"));
  const className = testCase.attributes.get("classname") ?? null;
  const name = testCase.attributes.get("name") ?? "";
  const failed = testCase.children.find((c) => c.name === "failure" || c.name === "error");
  if (failed === undefined) {
    const skipped = testCase.children.some((c) => c.name === "skipped");
    return skipped ? { kind: "skipped", suite, className, name, timeSeconds } : { kind: "passed", suite, className, name, timeSeconds };
  }
  return {
    suite,
    className,
    name,
    kind: failed.name === "failure" ? "failure" : "error",
    type: failed.attributes.get("type") || null,
    message: failed.attributes.get("message") || null,
    stack: failed.text,
    timeSeconds,
  };
}

/** A `time` attribute in seconds; `null` when missing or not a plain number (a localized `0,5`). */
function seconds(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
