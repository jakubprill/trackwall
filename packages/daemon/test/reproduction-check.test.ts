import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ReproductionCheck, type ReproTest, reproductionApi } from "@trackwall/protocol";
import { gitIn } from "./support/git-repo.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "r".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const REPORT = "target/surefire-reports/TEST-com.example.shop.CartTest.xml";
const TEST_FILE = "src/test/java/com/example/shop/CartTest.java";
const REPRO: ReproTest = { file: TEST_FILE, name: "CartTest#sumsTwoLines", failure: "expected: <3> but was: <4>" };

/**
 * The fake mise config (see `fixtures/fake-mise.ts`): its mise task `test` takes a filter (a usage spec, ADR-158),
 * writes `report` as the run's JUnit report and exits with `exit`. The config is a file of the repo, so a task that
 * changes it changes what the run "with the fix" reports, while the copy on the base still has the base's.
 */
function fakeMise(report: string, exit: number): string {
  return JSON.stringify({
    tasks: [{ name: "test", usage: 'arg "[filter]"' }],
    exits: { test: exit },
    prints: { test: ["[INFO] Tests run"] },
    writes: { test: { [REPORT]: report } },
  });
}
const FAILED_SUM = `<testsuite name="com.example.shop.CartTest"><testcase name="sumsTwoLines" classname="com.example.shop.CartTest" time="0.1"><failure message="expected: &lt;3&gt; but was: &lt;4&gt;" type="org.opentest4j.AssertionFailedError">trace</failure></testcase><testcase name="empty" classname="com.example.shop.CartTest" time="0.1"/></testsuite>`;
const PASSED_SUM = `<testsuite name="com.example.shop.CartTest"><testcase name="sumsTwoLines" classname="com.example.shop.CartTest" time="0.1"/><testcase name="empty" classname="com.example.shop.CartTest" time="0.1"/></testsuite>`;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      shop: {
        "fake-mise.json": fakeMise(FAILED_SUM, 1),
        "src/main/java/com/example/shop/Cart.java": "class Cart { int sum() { return 4; } }\n",
      },
      warehouse: { "fake-mise.json": fakeMise(PASSED_SUM, 0) },
      // Its `test` runs until it is stopped.
      slow: { "fake-mise.json": JSON.stringify({ tasks: [{ name: "test", usage: 'arg "[filter]"' }] }) },
    },
    miseCommand: FAKE_MISE,
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

/** A task of `repo` whose worktree gets `files` (path with `/` → content) and whose agent reports `reproTest`. */
async function taskWith(repo: string, files: Record<string, string>, reproTest: ReproTest | null) {
  const task = await daemon.facade.agents.createTask(repo, "fix the cart sum");
  for (const [path, content] of Object.entries(files)) {
    const file = join(task.worktree, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
  if (!session) throw new Error("the task has no session");
  await daemon.facade.agents.reportSummary(session.id, { text: "Fixed the sum.", checkSteps: [], reproTest });
  return task;
}

async function checked(task: string): Promise<ReproductionCheck> {
  const started = await daemon.post(reproductionApi.start, { task });
  expect(started.state).toBe("running");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const check = await daemon.post(reproductionApi.get, { task });
    if (check === null) throw new Error("the check is gone");
    if (check.state !== "running") return check;
    await sleep(50);
  }
  throw new Error("the check did not end in 30 s");
}

async function end(task: string): Promise<void> {
  for (const session of daemon.facade.agents.sessions().sessions.filter((s) => s.task === task))
    await daemon.facade.agents.stop(session.id);
  await daemon.facade.agents.removeTask(task, false, true);
}

describe.skipIf(process.versions.bun === undefined)("the reproduction check (ADR-227, real git and process groups, fake mise)", () => {
  test("a test that fails on the base and passes with the task's changes is reproduced, in a copy that goes afterwards", async () => {
    const task = await taskWith(
      "shop",
      {
        [TEST_FILE]: "class CartTest {}\n",
        "fake-mise.json": fakeMise(PASSED_SUM, 0),
        "src/main/java/com/example/shop/Cart.java": "class Cart {}\n",
      },
      REPRO,
    );
    const statusBefore = gitIn(task.worktree, "status", "--porcelain");

    const check = await checked(task.id);

    expect(check).toMatchObject({
      state: "reproduced",
      phase: null,
      filter: "CartTest",
      test: REPRO,
      message: null,
      base: {
        outcome: "failed",
        exitCode: 1,
        cases: 1,
        failure: { type: "org.opentest4j.AssertionFailedError", message: "expected: <3> but was: <4>" },
      },
      change: { outcome: "passed", exitCode: 0, cases: 1, failure: null },
    });
    expect(existsSync(`${task.worktree}.repro`)).toBe(false);
    // The task's worktree is only read: no report, no change.
    expect(gitIn(task.worktree, "status", "--porcelain")).toBe(statusBefore);
    expect(existsSync(join(task.worktree, ...REPORT.split("/")))).toBe(false);
    expect(readFileSync(join(task.worktree, "fake-mise.json"), "utf8")).toBe(fakeMise(PASSED_SUM, 0));
    await end(task.id);
  }, 60_000);

  test("a test that still fails with the task's changes is not reproduced", async () => {
    const task = await taskWith("shop", { [TEST_FILE]: "class CartTest {}\n" }, REPRO);
    const check = await checked(task.id);
    expect(check).toMatchObject({
      state: "not_reproduced",
      message: "the test still fails with the change",
      change: { outcome: "failed" },
    });
    await end(task.id);
  }, 60_000);

  test("a test that passes on the base does not show the error, and the change is not run", async () => {
    const task = await taskWith("warehouse", { [TEST_FILE]: "class CartTest {}\n" }, REPRO);
    const check = await checked(task.id);
    expect(check).toMatchObject({ state: "not_reproduced", base: { outcome: "passed" }, change: null });
    expect(check.message).toContain("passed on the base without the fix");
    await end(task.id);
  }, 60_000);

  test("a test missing from the base run's reports is inconclusive", async () => {
    const task = await taskWith("warehouse", { [TEST_FILE]: "class CartTest {}\n" }, { ...REPRO, name: "CartTest#neverWritten" });
    const check = await checked(task.id);
    expect(check).toMatchObject({ state: "inconclusive", base: { outcome: "missing", cases: 0 }, change: null });
    expect(check.message).toContain("did not run on the base");
    await end(task.id);
  }, 60_000);

  test("a check stopped while its run works ends cancelled, with its run's group stopped and its copy gone", async () => {
    const task = await taskWith("slow", { [TEST_FILE]: "class CartTest {}\n" }, REPRO);
    await daemon.post(reproductionApi.start, { task: task.id });
    const deadline = Date.now() + 30_000;
    while ((await daemon.post(reproductionApi.get, { task: task.id }))?.phase !== "base" && Date.now() < deadline) await sleep(50);

    const cancelled = await daemon.post(reproductionApi.cancel, { task: task.id });

    expect(cancelled).toMatchObject({ state: "cancelled", phase: null, message: "the check was stopped" });
    expect(existsSync(`${task.worktree}.repro`)).toBe(false);
    await end(task.id);
  }, 60_000);

  test("ending a task during its check stops the check first, so its run and its copy do not outlive the task", async () => {
    const task = await taskWith("slow", { [TEST_FILE]: "class CartTest {}\n" }, REPRO);
    await daemon.post(reproductionApi.start, { task: task.id });
    const deadline = Date.now() + 30_000;
    while ((await daemon.post(reproductionApi.get, { task: task.id }))?.phase !== "base" && Date.now() < deadline) await sleep(50);

    await end(task.id);

    expect(existsSync(`${task.worktree}.repro`)).toBe(false);
    expect(existsSync(task.worktree)).toBe(false);
    expect(await daemon.post(reproductionApi.get, { task: task.id })).toBeNull();
  }, 60_000);

  test("a test file the task did not change, or one that is not a Java class, is inconclusive without a run", async () => {
    const untouched = await taskWith("shop", { "fake-mise.json": fakeMise(PASSED_SUM, 0) }, REPRO);
    const notChanged = await checked(untouched.id);
    expect(notChanged).toMatchObject({
      state: "inconclusive",
      base: null,
      message: `${TEST_FILE} is not among the files the task changed`,
    });
    await end(untouched.id);

    const script = await taskWith("shop", { "src/test/cart.test.ts": "test()\n" }, { ...REPRO, file: "src/test/cart.test.ts" });
    const started = await daemon.post(reproductionApi.start, { task: script.id });
    expect(started).toMatchObject({ state: "inconclusive", base: null });
    expect(started.message).toContain("is not a Java source file named after its test class");
    await end(script.id);
  }, 60_000);

  test("a task whose agent named no reproduction test has nothing to check, and an ended task keeps no check", async () => {
    const task = await taskWith("shop", {}, null);
    await expect(daemon.post(reproductionApi.start, { task: task.id })).rejects.toThrow("named no reproduction test");
    await end(task.id);
    expect(await daemon.post(reproductionApi.get, { task: task.id })).toBeNull();
  }, 60_000);
});
