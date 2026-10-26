import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { GetSessionResult, VerifyTaskResult, verificationApi } from "@trackwall/protocol";
import { z } from "zod";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "v".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const REPORT = "target/surefire-reports/TEST-shop.CartTest.xml";
/**
 * Fake mise configs (see `fixtures/fake-mise.ts`): in `shop` the mise task `test` logs a Maven error, writes a JUnit
 * report with one failed test and exits with 1; in `warehouse` it passes without a report; `orders` has no `test`.
 */
const SHOP_MISE = JSON.stringify({
  tasks: [{ name: "test" }],
  exits: { test: 1 },
  prints: { test: ["[ERROR] Failures:", "[ERROR]   CartTest.sums:12 expected: <3> but was: <4>"] },
  writes: {
    test: {
      [REPORT]: `<testsuite name="shop.CartTest"><testcase name="sums" classname="shop.CartTest" time="0.1"><failure message="expected: &lt;3&gt; but was: &lt;4&gt;" type="AssertionFailedError">AssertionFailedError</failure></testcase><testcase name="empty" classname="shop.CartTest" time="0.1"/></testsuite>`,
    },
  },
});
const WAREHOUSE_MISE = JSON.stringify({ tasks: [{ name: "test" }], exits: { test: 0 } });
const ORDERS_MISE = JSON.stringify({ tasks: [{ name: "build" }], exits: { build: 0 } });
const TIMEOUT = 60_000;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall: only the daemon token, no session token. */
let outside: Client;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      shop: { "fake-mise.json": SHOP_MISE },
      warehouse: { "fake-mise.json": WAREHOUSE_MISE },
      orders: { "fake-mise.json": ORDERS_MISE },
    },
    miseCommand: FAKE_MISE,
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function verify(client: Client, args: Record<string, unknown>) {
  return client.callTool({ name: "verify_task", arguments: { timeoutSeconds: 30, ...args } });
}

function errorText(result: Awaited<ReturnType<typeof verify>>): string {
  expect(result.isError).toBe(true);
  const [first] = z.array(z.object({ text: z.string() })).parse(result.content);
  return first?.text ?? "";
}

async function sessionClient(task: string): Promise<{ client: Client; session: string }> {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task);
  if (!session) throw new Error("the task has no session");
  const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session.id);
  clients.push(client);
  return { client, session: session.id };
}

describe.skipIf(process.versions.bun === undefined)("verify_task (real worktree and process groups, fake mise)", () => {
  test(
    "a failing test run is failed with the failed test from the report and the run's errors from the log",
    async () => {
      const task = await daemon.facade.agents.createTask("shop", "fix the cart sum");

      const { verification } = VerifyTaskResult.parse((await verify(outside, { repo: "shop", task: task.id })).structuredContent);

      expect(verification).toMatchObject({
        task: task.id,
        repo: "shop",
        miseTask: "test",
        state: "failed",
        exitCode: 1,
        message: "mise task test exited with code 1",
        tests: { totals: { tests: 2, failures: 1, errors: 0 }, reports: 1, earlierReports: 0 },
      });
      expect(verification.failures.map((f) => [f.className, f.name, f.message])).toEqual([
        ["shop.CartTest", "sums", "expected: <3> but was: <4>"],
      ]);
      expect(verification.errors.map((e) => e.lines)).toEqual([
        ["[ERROR] Failures:", "[ERROR]   CartTest.sums:12 expected: <3> but was: <4>"],
      ]);
      // The same result for the task panel.
      expect(await daemon.post(verificationApi.get, { task: task.id })).toEqual(verification);
    },
    TIMEOUT,
  );

  test(
    "a passing run without reports passes, and the task's session sees the verdict in get_session",
    async () => {
      const task = await daemon.facade.agents.createTask("warehouse", "rename a field");
      const { client, session } = await sessionClient(task.id);

      const { verification } = VerifyTaskResult.parse((await verify(client, { repo: "warehouse", task: task.id })).structuredContent);
      expect(verification).toMatchObject({ state: "passed", exitCode: 0, message: "the run wrote no JUnit test reports", errors: [] });

      const seen = GetSessionResult.parse((await client.callTool({ name: "get_session", arguments: { session } })).structuredContent);
      expect(seen.verification).toEqual(verification);
    },
    TIMEOUT,
  );

  test(
    "a task session verifies only its own task, the supervisor none, and a worktree without the mise task test is not_found",
    async () => {
      const own = await daemon.facade.agents.createTask("warehouse", "own task");
      const other = await daemon.facade.agents.createTask("warehouse", "another agent's task");
      const { client } = await sessionClient(own.id);

      expect(errorText(await verify(client, { repo: "warehouse", task: other.id }))).toBe(
        `bad_request: a task session can verify only its own task ${own.id}, not task ${other.id}`,
      );
      expect(errorText(await verify(outside, { repo: "shop", task: own.id }))).toBe(
        `bad_request: task ${own.id} is in warehouse, not in shop`,
      );

      const supervisor = await daemon.facade.agents.startSupervisor();
      const asSupervisor = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, supervisor.id);
      clients.push(asSupervisor);
      expect(errorText(await verify(asSupervisor, { repo: "warehouse", task: own.id }))).toBe(
        `bad_request: the supervisor runs no tests; read task ${own.id}'s verification with get_session, or ask its session to verify it`,
      );

      const orders = await daemon.facade.agents.createTask("orders", "no tests here");
      expect(errorText(await verify(outside, { repo: "orders", task: orders.id }))).toStartWith("not_found:");
      expect(await daemon.post(verificationApi.get, { task: orders.id })).toBeNull();
    },
    TIMEOUT,
  );
});
