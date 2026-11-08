import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReproductionCheck, ReproductionRun, TestCase } from "@trackwall/protocol";
import { copyChanged, gitPath, testSide } from "../src/modules/reproduction/repro-copy.ts";
import { reproOutcome, reproTarget } from "../src/modules/reproduction/repro-test-case.ts";
import { ReproductionChecks } from "../src/modules/reproduction/reproduction-checks.ts";
import { reproductionVerdict } from "../src/modules/reproduction/reproduction-verdict.ts";
import { parseJunitReport } from "../src/modules/test-results/junit-report.ts";

const FILE = "orders/src/test/java/com/example/shop/OrderServiceTest.java";

function testCase(name: string, kind: TestCase["kind"], className = "com.example.shop.OrderServiceTest"): TestCase {
  const failed = kind === "failure" || kind === "error";
  return {
    suite: className,
    className,
    name,
    kind,
    type: failed ? "java.lang.IllegalStateException" : null,
    message: failed ? "no lines" : null,
  };
}

function run(outcome: ReproductionRun["outcome"]): ReproductionRun {
  return { runId: "run-1", exitCode: outcome === "failed" ? 1 : 0, outcome, cases: outcome === "missing" ? 0 : 1, failure: null };
}

describe("the reproduction test's target in the reports (ADR-227)", () => {
  test("the class comes from the file's name and the test from the name the agent gave, in any of its usual spellings", () => {
    for (const name of [
      "OrderServiceTest#totalOfEmptyOrder",
      "com.example.shop.OrderServiceTest.totalOfEmptyOrder()",
      "totalOfEmptyOrder",
    ]) {
      const target = reproTarget({ file: FILE, name, failure: "x" });
      if ("problem" in target) throw new Error(target.problem);
      expect(target.className).toBe("OrderServiceTest");
      expect(target.names.has("totalOfEmptyOrder")).toBe(true);
    }
  });

  test("a file that is not a Java class, or a class name a filter cannot hold, is no target", () => {
    expect(reproTarget({ file: "web/src/cart.test.ts", name: "sums", failure: "x" })).toEqual({
      problem:
        "web/src/cart.test.ts is not a Java source file named after its test class, so Trackwall cannot find its test in the reports",
    });
    expect("problem" in reproTarget({ file: "src/test/java/Order$Test.java", name: "sums", failure: "x" })).toBe(true);
  });

  test("a failed case of the test fails the run; other tests of the class and other classes do not count", () => {
    const target = reproTarget({ file: FILE, name: "OrderServiceTest#totalOfEmptyOrder", failure: "x" });
    if ("problem" in target) throw new Error(target.problem);
    const cases = [
      testCase("totalOfEmptyOrder", "failure"),
      testCase("otherTest", "error"),
      testCase("totalOfEmptyOrder", "passed", "com.example.shop.OtherServiceTest"),
    ];
    expect(reproOutcome(cases, target)).toEqual({
      outcome: "failed",
      cases: 1,
      failure: { type: "java.lang.IllegalStateException", message: "no lines" },
    });
    expect(reproOutcome([testCase("otherTest", "failure")], target)).toEqual({ outcome: "missing", cases: 0, failure: null });
  });

  test("Gradle's parentheses, parameterized runs and JUnit 5 nested classes are the same test", () => {
    const target = reproTarget({ file: FILE, name: "totalOf", failure: "x" });
    if ("problem" in target) throw new Error(target.problem);
    const cases = [
      testCase("totalOf()", "passed"),
      testCase("totalOf(int)[1]", "passed"),
      testCase("totalOf", "passed", "com.example.shop.OrderServiceTest$WhenEmpty"),
    ];
    expect(reproOutcome(cases, target)).toEqual({ outcome: "passed", cases: 3, failure: null });
    expect(reproOutcome([testCase("totalOf", "skipped")], target).outcome).toBe("skipped");
  });

  test("the cases come from a JUnit report as Surefire writes it, passed ones included", () => {
    const report = parseJunitReport(
      `<testsuite name="com.example.shop.OrderServiceTest"><testcase name="a" classname="com.example.shop.OrderServiceTest"/><testcase name="b" classname="com.example.shop.OrderServiceTest"><skipped/></testcase><testcase name="c" classname="com.example.shop.OrderServiceTest"><error type="java.lang.NullPointerException" message="order">trace</error></testcase></testsuite>`,
    );
    expect(report.cases).toEqual([
      {
        suite: "com.example.shop.OrderServiceTest",
        className: "com.example.shop.OrderServiceTest",
        name: "a",
        kind: "passed",
        type: null,
        message: null,
      },
      {
        suite: "com.example.shop.OrderServiceTest",
        className: "com.example.shop.OrderServiceTest",
        name: "b",
        kind: "skipped",
        type: null,
        message: null,
      },
      {
        suite: "com.example.shop.OrderServiceTest",
        className: "com.example.shop.OrderServiceTest",
        name: "c",
        kind: "error",
        type: "java.lang.NullPointerException",
        message: "order",
      },
    ]);
  });
});

describe("the reproduction check's verdict (ADR-227)", () => {
  test("failing without the fix and passing with it is reproduced", () => {
    expect(reproductionVerdict(run("failed"), run("passed"))).toEqual({ state: "reproduced", message: null });
  });

  test("passing without the fix, or failing with it, is not reproduced", () => {
    expect(reproductionVerdict(run("passed"), null).state).toBe("not_reproduced");
    expect(reproductionVerdict(run("failed"), run("failed"))).toEqual({
      state: "not_reproduced",
      message: "the test still fails with the change",
    });
  });

  test("a test that did not run or was skipped in either run is inconclusive", () => {
    expect(reproductionVerdict(run("missing"), null).state).toBe("inconclusive");
    expect(reproductionVerdict(run("skipped"), null).state).toBe("inconclusive");
    expect(reproductionVerdict(run("failed"), run("missing")).state).toBe("inconclusive");
    expect(reproductionVerdict(run("failed"), run("skipped")).state).toBe("inconclusive");
  });
});

describe("what a check copies from the task's worktree (ADR-227)", () => {
  test("the test sources of every module and the test's own file go onto the base; the rest comes with the change", () => {
    const paths = [
      "orders/src/test/java/A.java",
      "src/test/resources/orders.json",
      "src/main/java/Order.java",
      "it/OrderIT.java",
      "pom.xml",
    ];
    expect(testSide(paths, "it/OrderIT.java", [])).toEqual({
      tests: ["orders/src/test/java/A.java", "src/test/resources/orders.json", "it/OrderIT.java"],
      rest: ["src/main/java/Order.java", "pom.xml"],
    });
  });

  test("the test's file is found also as ./path or with backslashes, and the trusted mise config goes onto the base too", () => {
    const paths = ["it/OrderIT.java", "mise.toml", "src/main/java/Order.java"];
    expect(testSide(paths, "./it\\OrderIT.java", ["mise.toml", ".tool-versions"])).toEqual({
      tests: ["it/OrderIT.java", "mise.toml"],
      rest: ["src/main/java/Order.java"],
    });
    expect(gitPath("./it\\OrderIT.java")).toBe("it/OrderIT.java");
  });

  test("a copied file is newer than the copy started, so a build that compares times recompiles it", async () => {
    const root = mkdtempSync(join(tmpdir(), "trackwall-repro-times-"));
    mkdirSync(join(root, "task", "src", "main"), { recursive: true });
    mkdirSync(join(root, "task.repro"));
    const source = join(root, "task", "src", "main", "Order.java");
    writeFileSync(source, "class Order {}\n");
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(source, anHourAgo, anHourAgo);
    const started = Date.now() - 1000;

    await copyChanged(join(root, "task"), join(root, "task.repro"), ["src/main/Order.java"]);

    expect(statSync(join(root, "task.repro", "src", "main", "Order.java")).mtimeMs).toBeGreaterThanOrEqual(started);
  });

  test("a changed file is copied, a deleted one deleted, and a link or a path under a linked folder is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "trackwall-repro-copy-"));
    const worktree = join(root, "task");
    const copy = join(root, "task.repro");
    mkdirSync(join(worktree, "src", "test"), { recursive: true });
    mkdirSync(join(copy, "src", "main"), { recursive: true });
    writeFileSync(join(worktree, "src", "test", "OrderTest.java"), "class OrderTest {}\n");
    writeFileSync(join(copy, "src", "main", "Old.java"), "class Old {}\n");

    await copyChanged(worktree, copy, ["src/test/OrderTest.java", "src/main/Old.java"]);

    expect(readFileSync(join(copy, "src", "test", "OrderTest.java"), "utf8")).toBe("class OrderTest {}\n");
    expect(existsSync(join(copy, "src", "main", "Old.java"))).toBe(false);

    if (process.platform === "win32") return; // Links need the developer mode on Windows; the refusal does not depend on the system.
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(worktree, "linked.txt"));
    symlinkSync(outside, join(worktree, "linked-dir"));
    await expect(copyChanged(worktree, copy, ["linked.txt"])).rejects.toThrow("linked.txt is a link in the task's worktree");
    await expect(copyChanged(worktree, copy, ["linked-dir/secret.txt"])).rejects.toThrow("lies under a linked folder");
    symlinkSync(outside, join(copy, "into-outside"));
    writeFileSync(join(worktree, "plain.txt"), "plain\n");
    mkdirSync(join(worktree, "into-outside"));
    writeFileSync(join(worktree, "into-outside", "new.txt"), "new\n");
    await expect(copyChanged(worktree, copy, ["into-outside/new.txt"])).rejects.toThrow("lies under a linked folder");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });
});

describe("reproduction checks across a daemon restart (ADR-227)", () => {
  test.each([
    { left: "running, as a crash leaves it", state: "running" as const, message: null },
    {
      left: "cancelled by the daemon's stop",
      state: "cancelled" as const,
      message: "Trackwall stopped during the check, so it has no verdict; check again",
    },
  ])("a check the previous daemon left $left comes back cancelled, and the copy it left is removed", async ({ state, message }) => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-repro-restart-"));
    const file = join(home, "reproduction-checks.json");
    const task = "44444444-4444-4444-8444-444444444444";
    const check: ReproductionCheck = {
      task,
      repo: "shop",
      test: { file: "src/test/java/CartTest.java", name: "CartTest#sums", failure: "x" },
      filter: null,
      state,
      phase: state === "running" ? "base" : null,
      startedAt: "2026-11-08T10:00:00.000Z",
      finishedAt: null,
      base: null,
      change: null,
      message,
    };
    writeFileSync(file, JSON.stringify({ checks: [check] }));
    const removed: string[] = [];
    const checks = new ReproductionChecks({
      tasks: {
        findTask: () => ({ repo: "shop" }),
        reproSubject: () => {
          throw new Error("not in this test");
        },
        reproCopyOf: () => ({ repo: "shop", copy: "/worktrees/shop/cart.repro" }),
      },
      vcs: {
        addCheckout: async () => {},
        removeWorktree: async (_repoDir, path) => {
          removed.push(path);
        },
        changedPaths: async () => ({ paths: [], truncated: false }),
        worktreeFingerprint: async () => "",
        copyIncludedFiles: async () => {},
      },
      repos: { repoPath: async () => "/projects/shop" },
      mise: {
        runInReproCopy: async () => {
          throw new Error("not in this test");
        },
      },
      reports: { casesIn: async () => ({ cases: [], unread: 0, truncated: false }) },
      file,
      log: () => {},
    });

    expect(checks.get(task)).toMatchObject({
      state: "cancelled",
      phase: null,
      message: "Trackwall stopped during the check, so it has no verdict; check again",
    });
    await checks.cancel(task);
    expect(removed).toEqual(["/worktrees/shop/cart.repro"]);
  });
});
