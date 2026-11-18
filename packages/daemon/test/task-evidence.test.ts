import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ReproTest, reproductionApi, taskEvidenceApi, verificationApi } from "@trackwall/protocol";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "e".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const REPORT = "target/surefire-reports/TEST-com.example.shop.CartTest.xml";
const TEST_FILE = "src/test/java/com/example/shop/CartTest.java";
const REPRO: ReproTest = { file: TEST_FILE, name: "CartTest#sumsTwoLines", failure: "expected: <3> but was: <4>" };

/** The fake mise config (see `fixtures/fake-mise.ts`): `test` takes a filter, writes `report` and exits with `exit`. */
function fakeMise(report: string, exit: number): string {
  return JSON.stringify({
    tasks: [{ name: "test", usage: 'arg "[filter]"' }],
    exits: { test: exit },
    writes: { test: { [REPORT]: report } },
  });
}
const FAILED_SUM = `<testsuite name="com.example.shop.CartTest"><testcase name="sumsTwoLines" classname="com.example.shop.CartTest" time="0.1"><failure message="expected: &lt;3&gt; but was: &lt;4&gt;" type="org.opentest4j.AssertionFailedError">trace</failure></testcase></testsuite>`;
const PASSED_SUM = `<testsuite name="com.example.shop.CartTest"><testcase name="sumsTwoLines" classname="com.example.shop.CartTest" time="0.1"/></testsuite>`;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, { repos: { shop: { "fake-mise.json": fakeMise(FAILED_SUM, 1) } }, miseCommand: FAKE_MISE });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

function write(worktree: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(worktree, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

async function report(task: string, reproTest: ReproTest | null): Promise<void> {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task);
  if (!session) throw new Error("the task has no session");
  await daemon.facade.agents.reportSummary(session.id, { text: "Fixed the sum.", checkSteps: [], reproTest });
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await sleep(50);
  }
  throw new Error("nothing changed in 30 s");
}

async function end(task: string): Promise<void> {
  for (const session of daemon.facade.agents.sessions().sessions.filter((s) => s.task === task))
    await daemon.facade.agents.stop(session.id);
  await daemon.facade.agents.removeTask(task, false, true);
}

describe.skipIf(process.versions.bun === undefined)("a task's evidence (ADR-276, real git and process groups, fake mise)", () => {
  test("a fresh task has only gaps: no approved plan, no reproduction test, no verification, no rules check", async () => {
    const task = await daemon.facade.agents.createTask("shop", "fix the cart sum");

    expect(await daemon.post(taskEvidenceApi.get, { task: task.id })).toEqual({
      task: task.id,
      planApproved: false,
      reproduction: null,
      verification: null,
      rules: null,
      usage: null,
      models: [],
    });
    await end(task.id);
  }, 60_000);

  test("a reproduced test is Trackwall's verdict until the task's files change after the check, then it is outdated", async () => {
    const task = await daemon.facade.agents.createTask("shop", "fix the cart sum");
    write(task.worktree, { [TEST_FILE]: "class CartTest {}\n", "fake-mise.json": fakeMise(PASSED_SUM, 0) });
    await report(task.id, REPRO);
    expect((await daemon.post(taskEvidenceApi.get, { task: task.id })).reproduction).toEqual({ test: REPRO, check: null, outdated: false });

    await daemon.post(reproductionApi.start, { task: task.id });
    const checked = await until(
      () => daemon.post(taskEvidenceApi.get, { task: task.id }),
      (evidence) => evidence.reproduction?.check?.state !== "running",
    );
    expect(checked.reproduction).toMatchObject({ test: REPRO, check: { state: "reproduced" }, outdated: false });

    // The agent goes on working after the check.
    write(task.worktree, { "src/main/java/com/example/shop/Cart.java": "class Cart { int sum() { return 3; } }\n" });

    expect((await daemon.post(taskEvidenceApi.get, { task: task.id })).reproduction).toMatchObject({
      check: { state: "reproduced" },
      outdated: true,
    });
    await end(task.id);
  }, 60_000);

  test("a check of a test the agent named before is left out once it names another one", async () => {
    const task = await daemon.facade.agents.createTask("shop", "fix the cart sum");
    write(task.worktree, { [TEST_FILE]: "class CartTest {}\n" });
    await report(task.id, REPRO);
    await daemon.post(reproductionApi.start, { task: task.id });
    await until(
      () => daemon.post(reproductionApi.get, { task: task.id }),
      (check) => check?.state !== "running",
    );

    const other = { ...REPRO, name: "CartTest#sumsOneLine" };
    await report(task.id, other);

    expect((await daemon.post(taskEvidenceApi.get, { task: task.id })).reproduction).toEqual({ test: other, check: null, outdated: false });
    await end(task.id);
  }, 60_000);

  test("the task's last verification is in its evidence, the same as the verification itself", async () => {
    const task = await daemon.facade.agents.createTask("shop", "fix the cart sum");
    await daemon.post(verificationApi.start, { task: task.id });
    const verification = await until(
      () => daemon.post(verificationApi.get, { task: task.id }),
      (v) => v !== null && v.state !== "running",
    );

    expect(verification?.state).toBe("failed");
    expect((await daemon.post(taskEvidenceApi.get, { task: task.id })).verification).toEqual(verification);
    await end(task.id);
  }, 60_000);

  test("an unknown task has no evidence", async () => {
    await expect(daemon.post(taskEvidenceApi.get, { task: "no-such-task" })).rejects.toThrow();
  });
});
