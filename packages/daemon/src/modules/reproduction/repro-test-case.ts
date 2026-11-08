import type { ReproductionRun, ReproTest } from "@trackwall/protocol";

/**
 * Which test cases of JUnit reports are an agent's reproduction test (ADR-227): the test class comes from the file's
 * name, the test from the name the agent gave. Both are only compared with what the reports say; the class name is also
 * the one word the check hands the repo's mise task `test` as its filter (ADR-158), so it is held to a Java identifier.
 */

/** The test class and the names its test case may carry in a report. */
export interface ReproTarget {
  /** The simple class name from the file name: `OrderServiceTest` for `…/OrderServiceTest.java`. */
  className: string;
  /** The method name and the name as the agent wrote it, any of which a report's test case may carry. */
  names: ReadonlySet<string>;
}

/** A test case of a report, as the `test-results` module reads it. */
export interface ReproCase {
  suite: string;
  className: string | null;
  name: string;
  kind: "passed" | "skipped" | "failure" | "error";
  type: string | null;
  message: string | null;
}

/** A Java class name without `$`, which a mise task argument cannot hold. */
const JAVA_CLASS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JAVA_FILE = /^(.+)\.java$/;
/** `OrderServiceTest#totalOf`, `com.example.OrderServiceTest.totalOf()`, `totalOf(int)`: the last name before any parameters. */
const METHOD = /(?:^|[#.])([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\([^)]*\))?\s*$/;

/** The target of the test, or why it cannot be one: only a Java source file named after its class is. */
export function reproTarget(test: ReproTest): ReproTarget | { problem: string } {
  const base = test.file.split(/[\\/]/).at(-1) ?? "";
  const className = JAVA_FILE.exec(base)?.[1];
  if (className === undefined || !JAVA_CLASS.test(className))
    return {
      problem: `${test.file} is not a Java source file named after its test class, so Trackwall cannot find its test in the reports`,
    };
  const names = new Set([test.name.trim()]);
  const method = METHOD.exec(test.name.trim())?.[1];
  if (method !== undefined) names.add(method);
  return { className, names };
}

/** What one run's cases say about the target: failed if one failed, passed if all passed, `missing` without any. */
export function reproOutcome(cases: readonly ReproCase[], target: ReproTarget): Omit<ReproductionRun, "runId" | "exitCode"> {
  const own = cases.filter((c) => isTargetClass(c, target.className) && isTargetName(c.name, target.names));
  const failed = own.find((c) => c.kind === "failure" || c.kind === "error");
  const failure = failed ? { type: failed.type, message: failed.message } : null;
  if (own.length === 0) return { outcome: "missing", cases: 0, failure };
  if (failed) return { outcome: "failed", cases: own.length, failure };
  if (own.every((c) => c.kind === "skipped")) return { outcome: "skipped", cases: own.length, failure };
  return { outcome: "passed", cases: own.length, failure };
}

/**
 * The case's class is the target class, also as a nested class of it (`OrderServiceTest$WhenEmpty`, JUnit 5's
 * `@Nested`); a report without a class name names it in the suite.
 */
function isTargetClass(c: ReproCase, className: string): boolean {
  const simple = (c.className ?? c.suite).split(".").at(-1) ?? "";
  return simple === className || simple.startsWith(`${className}$`);
}

/**
 * The case's name is one of the target's, without what reports add after it: Gradle's `totalOf()`, a parameterized
 * test's `totalOf(int)[1]` or `[1] 42`.
 */
function isTargetName(name: string, names: ReadonlySet<string>): boolean {
  const bare = name.split(/[([]/)[0]?.trim() ?? "";
  return names.has(name.trim()) || names.has(bare);
}
