import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { GetReviewCommentsResult, taskTestsApi } from "@trackwall/protocol";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "t".repeat(43);
const TIMEOUT = 60_000;
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const CART_REPORT = "target/surefire-reports/TEST-shop.CartTest.xml";
const PRICE_REPORT = "build/test-results/test/TEST-shop.PriceTest.xml";
/** Two failed tests, a passed and a skipped one, as Surefire writes them. */
const CART = `<testsuite name="shop.CartTest">
<testcase name="sums" classname="shop.CartTest" time="0.1"><failure message="expected: &lt;3&gt; but was: &lt;4&gt;" type="AssertionFailedError">AssertionFailedError: expected: &lt;3&gt; but was: &lt;4&gt;
	at shop.CartTest.sums(CartTest.java:12)</failure></testcase>
<testcase name="empty" classname="shop.CartTest" time="0.2"/>
<testcase name="logsIn" classname="shop.CartTest" time="0.3"><error message="no connection" type="java.net.ConnectException">java.net.ConnectException: no connection</error></testcase>
<testcase name="inYen" classname="shop.CartTest"><skipped/></testcase>
</testsuite>`;
const PRICE = `<testsuite name="shop.PriceTest"><testcase name="rounds" classname="shop.PriceTest" time="0.05"/></testsuite>`;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "src/Cart.java": "class Cart {}\n", "fake-mise.json": JSON.stringify({ tasks: [], exits: {} }) } },
    miseCommand: FAKE_MISE,
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

/** Writes a file into a worktree with the given modification time. */
function write(worktree: string, path: string, content: string, at: Date): void {
  const file = join(worktree, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, at, at);
}

describe.skipIf(process.versions.bun === undefined)("the Tests tab of a task (real worktree, ADR-304)", () => {
  test(
    "lists every test of the worktree's reports, failed ones first with their details",
    async () => {
      const task = await daemon.facade.agents.createTask("shop", "fix the cart sum");
      write(task.worktree, CART_REPORT, CART, new Date(Date.now() - 60_000));
      write(task.worktree, PRICE_REPORT, PRICE, new Date(Date.now() - 120_000));

      const tests = await daemon.post(taskTestsApi.get, { task: task.id });

      expect(tests.totals).toEqual({ tests: 5, failures: 1, errors: 1, skipped: 1, timeSeconds: 0.65 });
      expect(tests.reports).toBe(2);
      expect(tests.cases.map((c) => [c.report, c.className, c.name, c.kind, c.failure])).toEqual([
        [CART_REPORT, "shop.CartTest", "sums", "failure", 0],
        [CART_REPORT, "shop.CartTest", "logsIn", "error", 1],
        [CART_REPORT, "shop.CartTest", "inYen", "skipped", null],
        [CART_REPORT, "shop.CartTest", "empty", "passed", null],
        [PRICE_REPORT, "shop.PriceTest", "rounds", "passed", null],
      ]);
      expect(tests.failures.map((f) => [f.name, f.message, f.lines])).toEqual([
        [
          "sums",
          "expected: <3> but was: <4>",
          ["AssertionFailedError: expected: <3> but was: <4>", "\tat shop.CartTest.sums(CartTest.java:12)"],
        ],
        ["logsIn", "no connection", ["java.net.ConnectException: no connection"]],
      ]);
      expect(tests.changedAfter).toBe(false);
      expect(tests.truncated).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "says the reports may be out of date once a file the task changed is written after the newest of them",
    async () => {
      const task = await daemon.facade.agents.createTask("shop", "fix the cart total");
      write(task.worktree, CART_REPORT, CART, new Date(Date.now() - 60_000));
      expect((await daemon.post(taskTestsApi.get, { task: task.id })).changedAfter).toBe(false);

      write(task.worktree, "src/Cart.java", "class Cart { int total; }\n", new Date());

      expect((await daemon.post(taskTestsApi.get, { task: task.id })).changedAfter).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a worktree without reports has no tests and nothing to fix",
    async () => {
      const task = await daemon.facade.agents.createTask("shop", "add a discount");

      const tests = await daemon.post(taskTestsApi.get, { task: task.id });

      expect(tests).toMatchObject({ reports: 0, newestReportAt: null, cases: [], failures: [], changedAfter: false });
      await expect(daemon.post(taskTestsApi.fixTests, { task: task.id, test: null })).rejects.toThrow(
        "the test reports have no failed test to fix",
      );
    },
    TIMEOUT,
  );

  test(
    '"Fix this" hands the test the user picked to the task\'s agent, which reads it with get_review_comments',
    async () => {
      const task = await daemon.facade.agents.createTask("shop", "fix the cart login");
      write(task.worktree, CART_REPORT, CART, new Date(Date.now() - 60_000));
      const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
      if (!session) throw new Error("the task has no session");
      const client = await connectSessionClient(daemon.api.port, daemon.home, session.id);
      clients.push(client);
      const { failures } = await daemon.post(taskTestsApi.get, { task: task.id });

      const picked = { report: CART_REPORT, className: "shop.CartTest", name: "logsIn" };
      const { delivery } = await daemon.post(taskTestsApi.fixTests, { task: task.id, test: picked });

      expect(["typed", "queued"]).toContain(delivery);
      const read = GetReviewCommentsResult.parse((await client.callTool({ name: "get_review_comments", arguments: {} })).structuredContent);
      expect(read.testFix).toEqual({ runId: null, outdated: false, failures: failures.slice(1, 2), otherFailures: 1 });
      await expect(daemon.post(taskTestsApi.fixTests, { task: task.id, test: { ...picked, name: "noSuchTest" } })).rejects.toThrow(
        `no failed test noSuchTest in ${CART_REPORT}`,
      );
    },
    TIMEOUT,
  );
});
