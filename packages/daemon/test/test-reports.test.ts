import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TestReports } from "../src/modules/test-results/test-reports.ts";

const PASSING = `<testsuite name="a.PassTest"><testcase name="ok" classname="a.PassTest" time="0.5"/></testsuite>`;
const FAILING = `<testsuite name="a.FailTest"><testcase name="breaks" classname="a.FailTest" time="1"><failure message="token abcdefgh12345 rejected" type="AssertionError">AssertionError: token abcdefgh12345 rejected</failure></testcase></testsuite>`;

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-test-results-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function testResults(repoDir: string, worktrees: Record<string, string> = {}) {
  return new TestReports({
    repos: { repoPath: async () => repoDir },
    tasks: {
      task: (id) => {
        const worktree = worktrees[id];
        if (worktree === undefined) throw new Error(`no task ${id}`);
        return { worktree };
      },
    },
    logs: { mask: (text) => text.replaceAll("abcdefgh12345", "***") },
    env: async () => ({}),
  });
}

describe("test results from the reports in a checkout", () => {
  test("sums Maven and Gradle reports of every module and lists the failures with secrets masked", async () => {
    const dir = checkout({
      "orders/target/surefire-reports/TEST-a.PassTest.xml": PASSING,
      "orders/target/failsafe-reports/TEST-a.FailTest.xml": FAILING,
      "billing/build/test-results/test/TEST-a.PassTest.xml": PASSING,
      "web/junit.xml": PASSING,
    });

    const results = await testResults(dir).results({ repo: "shop", task: null }, undefined);

    expect(results.dir).toBe(dir);
    expect(results.totals).toEqual({ tests: 4, failures: 1, errors: 0, skipped: 0, timeSeconds: 2.5 });
    expect(results.reports.map((r) => r.path).sort()).toEqual([
      "billing/build/test-results/test/TEST-a.PassTest.xml",
      "orders/target/failsafe-reports/TEST-a.FailTest.xml",
      "orders/target/surefire-reports/TEST-a.PassTest.xml",
      "web/junit.xml",
    ]);
    expect(results.failures).toEqual([
      {
        report: "orders/target/failsafe-reports/TEST-a.FailTest.xml",
        suite: "a.FailTest",
        className: "a.FailTest",
        name: "breaks",
        kind: "failure",
        type: "AssertionError",
        message: "token *** rejected",
        lines: ["AssertionError: token *** rejected"],
        omittedLines: 0,
        timeSeconds: 1,
      },
    ]);
    expect(results).toMatchObject({ problems: [], truncated: false });
  });

  test("skips sources, dependencies, hidden directories and build output outside the report directories", async () => {
    const dir = checkout({
      "src/test/resources/TEST-fixture.xml": FAILING,
      "node_modules/lib/junit.xml": FAILING,
      ".gradle/TEST-cache.xml": FAILING,
      "target/classes/TEST-copied.xml": FAILING,
      "target/surefire-reports/TEST-a.PassTest.xml": PASSING,
    });

    const results = await testResults(dir).results({ repo: "shop", task: null }, undefined);

    expect(results.reports.map((r) => r.path)).toEqual(["target/surefire-reports/TEST-a.PassTest.xml"]);
    expect(results.totals.failures).toBe(0);
  });

  test("since leaves out reports an earlier run wrote", async () => {
    const dir = checkout({
      "target/surefire-reports/TEST-a.FailTest.xml": FAILING,
      "target/surefire-reports/TEST-a.PassTest.xml": PASSING,
    });
    const old = new Date("2026-01-01T10:00:00Z");
    utimesSync(join(dir, "target/surefire-reports/TEST-a.FailTest.xml"), old, old);

    const results = await testResults(dir).results({ repo: "shop", task: null }, "2026-01-01T11:00:00Z");

    expect(results.reports.map((r) => r.path)).toEqual(["target/surefire-reports/TEST-a.PassTest.xml"]);
    expect(results.failures).toEqual([]);
    expect(results.earlierReports).toBe(1);
  });

  test("old reports do not crowd fresh ones out of the report limit", async () => {
    const files: Record<string, string> = { "b/target/surefire-reports/TEST-a.FailTest.xml": FAILING };
    for (let i = 0; i < 2001; i++) files[`a/target/surefire-reports/TEST-a.Old${i}.xml`] = PASSING;
    const dir = checkout(files);
    const old = new Date("2026-01-01T10:00:00Z");
    for (let i = 0; i < 2001; i++) utimesSync(join(dir, `a/target/surefire-reports/TEST-a.Old${i}.xml`), old, old);

    const results = await testResults(dir).results({ repo: "shop", task: null }, "2026-01-01T11:00:00Z");

    expect(results.totals).toMatchObject({ tests: 1, failures: 1 });
    expect(results).toMatchObject({ earlierReports: 2001, truncated: false });
  });

  test("TestNG's second copy of the results under Surefire's directory is not counted again", async () => {
    const dir = checkout({
      "target/surefire-reports/TEST-TestSuite.xml": FAILING,
      "target/surefire-reports/junitreports/TEST-a.FailTest.xml": FAILING,
    });

    const results = await testResults(dir).results({ repo: "shop", task: null }, undefined);

    expect(results.totals.failures).toBe(1);
  });

  test("a secret is masked before a long message is cut, so no part of it is left", async () => {
    const message = `${"x".repeat(1995)}abcdefgh12345 and more`;
    const dir = checkout({
      "target/surefire-reports/TEST-a.LongTest.xml": `<testsuite name="a.LongTest"><testcase name="long" classname="a.LongTest"><failure message="${message}">${message}</failure></testcase></testsuite>`,
    });

    const [failure] = (await testResults(dir).results({ repo: "shop", task: null }, undefined)).failures;

    expect(failure?.message).toBe(`${"x".repeat(1995)}*** a`);
    expect(failure?.lines.join("")).not.toContain("abcde");
  });

  test("a report that is not valid XML is a problem, not a failure of the whole read", async () => {
    const dir = checkout({
      "target/surefire-reports/TEST-a.Broken.xml": "<testsuite><testcase>",
      "target/surefire-reports/TEST-a.PassTest.xml": PASSING,
    });

    const results = await testResults(dir).results({ repo: "shop", task: null }, undefined);

    expect(results.totals.tests).toBe(1);
    expect(results.problems).toEqual([{ path: "target/surefire-reports/TEST-a.Broken.xml", message: "unclosed element <testcase>" }]);
  });

  test("reads a task's worktree instead of the repo root", async () => {
    const root = checkout({ "target/surefire-reports/TEST-a.PassTest.xml": PASSING });
    const worktree = checkout({ "target/surefire-reports/TEST-a.FailTest.xml": FAILING });

    const results = await testResults(root, { t1: worktree }).results({ repo: "shop", task: "t1" }, undefined);

    expect(results.dir).toBe(worktree);
    expect(results.totals).toMatchObject({ tests: 1, failures: 1 });
  });

  test("a checkout without reports gives zero counts, and a missing one is not_found", async () => {
    const empty = checkout({ "README.md": "# shop\n" });
    expect(await testResults(empty).results({ repo: "shop", task: null }, undefined)).toMatchObject({
      totals: { tests: 0, failures: 0, errors: 0, skipped: 0, timeSeconds: null },
      reports: [],
    });
    await expect(testResults(join(empty, "gone")).results({ repo: "shop", task: null }, undefined)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
