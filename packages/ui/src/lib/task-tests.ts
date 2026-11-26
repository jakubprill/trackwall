import type { TaskTestCase, TaskTests } from "@trackwall/protocol";

/**
 * The "Tests" tab of a task (ADR-304): the tests of the reports in its worktree, by default only the failed ones, and on
 * request the skipped or all of them, grouped by test class and narrowed by a name, without pages. No React here, so
 * the grouping and filtering are tested on their own.
 */

/** Which tests the tab lists. */
export type TestsFilter = "failed" | "skipped" | "all";

export const TESTS_FILTERS: readonly { id: TestsFilter; label: string }[] = [
  { id: "failed", label: "Failed" },
  { id: "skipped", label: "Skipped" },
  { id: "all", label: "All" },
];

/** The tests of one class (or suite, without a class name), in the order of the answer: failed, skipped, passed. */
export interface TestGroup {
  name: string;
  /** The tests the filter and the name let through. */
  cases: TaskTestCase[];
  /** Failed tests of the class, whatever the filter. */
  failed: number;
  /** Tests of the class in the answer, whatever the filter. */
  total: number;
}

export function isFailed(c: Pick<TaskTestCase, "kind">): boolean {
  return c.kind === "failure" || c.kind === "error";
}

/** Failed tests of the reports; the tab's red count. */
export function failedCount(tests: Pick<TaskTests, "totals">): number {
  return tests.totals.failures + tests.totals.errors;
}

/** How many tests a filter shows before a name narrows it, for its chip. */
export function filterCount(tests: Pick<TaskTests, "totals">, filter: TestsFilter): number {
  if (filter === "failed") return failedCount(tests);
  return filter === "skipped" ? tests.totals.skipped : tests.totals.tests;
}

function passesFilter(c: TaskTestCase, filter: TestsFilter): boolean {
  if (filter === "failed") return isFailed(c);
  return filter === "skipped" ? c.kind === "skipped" : true;
}

/** A name matches when the test's or its class's name holds the typed text, in any case. */
function matchesName(c: TaskTestCase, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  return c.name.toLowerCase().includes(text) || (c.className ?? c.suite).toLowerCase().includes(text);
}

/** The groups the tab lists: classes with a test the filter and the name let through, classes with failed tests first. */
export function testGroups(cases: readonly TaskTestCase[], filter: TestsFilter, query: string): TestGroup[] {
  const groups = new Map<string, TestGroup>();
  for (const c of cases) {
    const name = c.className ?? c.suite;
    const group = groups.get(name) ?? { name, cases: [], failed: 0, total: 0 };
    groups.set(name, group);
    group.total++;
    if (isFailed(c)) group.failed++;
    if (passesFilter(c, filter) && matchesName(c, query)) group.cases.push(c);
  }
  return [...groups.values()].filter((g) => g.cases.length > 0);
}

/** A class starts unfolded unless it has nothing but passed or skipped tests in "All": those the user rarely opens. */
export function startsOpen(group: TestGroup, filter: TestsFilter): boolean {
  return filter !== "all" || group.failed > 0;
}

/** What a folded or open class says next to its name: how many of its tests failed, or that all of them passed. */
export function groupCountLabel(group: TestGroup): string {
  return group.failed > 0 ? `${group.failed} of ${group.total}` : `${group.total} passed`;
}

/**
 * A test's key in the list and for the one selected: its report and names, and its place among tests with the same
 * ones, since a report repeats a test's name for retries and parameterized runs.
 */
export function testKeys(cases: readonly TaskTestCase[]): Map<TaskTestCase, string> {
  const seen = new Map<string, number>();
  const keys = new Map<TaskTestCase, string>();
  for (const c of cases) {
    const base = `${c.report}\n${c.className ?? ""}\n${c.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keys.set(c, `${base}\n${n}`);
  }
  return keys;
}

/** A test's time as the list shows it, `0.04 s`; nothing when the report has none. */
export function testTime(seconds: number | null): string {
  return seconds === null ? "" : `${seconds.toFixed(2)} s`;
}
