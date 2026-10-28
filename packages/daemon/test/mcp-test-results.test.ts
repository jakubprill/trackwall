import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { TestResults } from "@trackwall/protocol";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "j".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let client: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n" }, warehouse: { "README.md": "# warehouse\n" } },
    miseCommand: ["mise"],
  });
  client = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await daemon.stop();
});

function writeReport(dir: string): void {
  mkdirSync(join(dir, "target", "surefire-reports"), { recursive: true });
  writeFileSync(
    join(dir, "target", "surefire-reports", "TEST-shop.CartTest.xml"),
    `<testsuite name="shop.CartTest"><testcase name="sums" classname="shop.CartTest" time="0.1"><failure message="expected 3" type="AssertionError">AssertionError: expected 3</failure></testcase></testsuite>`,
  );
}

describe.skipIf(process.versions.bun === undefined)("get_test_results (real worktree, fake Copilot CLI)", () => {
  test("reads the reports a test run left in a task's worktree, not those of the repo root", async () => {
    const task = await daemon.facade.agents.createTask("shop", "fix the cart sum");
    writeReport(task.worktree);

    const inTask = TestResults.parse(
      (await client.callTool({ name: "get_test_results", arguments: { repo: "shop", task: task.id } })).structuredContent,
    );
    expect(inTask.totals).toMatchObject({ tests: 1, failures: 1 });
    expect(inTask.failures.map((f) => [f.className, f.name, f.message])).toEqual([["shop.CartTest", "sums", "expected 3"]]);

    const inRoot = TestResults.parse((await client.callTool({ name: "get_test_results", arguments: { repo: "shop" } })).structuredContent);
    expect(inRoot.totals.tests).toBe(0);
  }, 60_000);

  test("a task of another repo is bad_request and an unknown repo not_found, not empty results", async () => {
    const task = await daemon.facade.agents.createTask("shop", "another task");
    const other = await client.callTool({ name: "get_test_results", arguments: { repo: "warehouse", task: task.id } });
    expect(other.content).toEqual([{ type: "text", text: `bad_request: task ${task.id} is in shop, not in warehouse` }]);
    const unknown = await client.callTool({ name: "get_test_results", arguments: { repo: "shpo" } });
    expect(JSON.stringify(unknown.content)).toContain('"text":"not_found:');
  }, 60_000);
});
