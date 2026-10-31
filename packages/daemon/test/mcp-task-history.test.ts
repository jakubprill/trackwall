import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { TaskHistoryResult } from "@trackwall/protocol";
import { gitIn } from "./support/git-repo.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "h".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let client: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n", "src/cart.ts": "export const cart = [];\n" } },
    miseCommand: ["mise"],
  });
  client = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await daemon.stop();
});

describe.skipIf(process.versions.bun === undefined)("the task journal and search_task_history (real git, fake Copilot CLI)", () => {
  test("an ended task leaves its prompt, summary, commits and files, which search_task_history finds by words", async () => {
    const agents = daemon.facade.agents;
    const task = await agents.createTask("shop", "Add a retry to the payment call");
    writeFileSync(join(task.worktree, "src", "cart.ts"), "export const cart = [];\nexport const retries = 3;\n");
    gitIn(task.worktree, "commit", "-qam", "Retry the payment call three times");
    const head = gitIn(task.worktree, "rev-parse", "HEAD").trim();
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (!session) throw new Error("the task has no session");
    agents.reportSummary(session.id, "Retries the payment call; the BFF needs no change.");
    await agents.stop(session.id);

    await agents.removeTask(task.id, true, false);

    const search = async (args: Record<string, unknown>) =>
      TaskHistoryResult.parse((await client.callTool({ name: "search_task_history", arguments: args })).structuredContent);
    const found = await search({ text: "PAYMENT bff" });
    expect(found.truncated).toBe(false);
    expect(found.tasks).toEqual([
      {
        task: task.id,
        repo: "shop",
        title: null,
        prompt: "Add a retry to the payment call",
        branch: task.branch,
        baseBranch: task.baseBranch,
        base: task.base,
        head,
        branchKept: true,
        createdAt: task.createdAt,
        endedAt: expect.any(String),
        proposed: false,
        item: null,
        handoffFrom: null,
        summary: "Retries the payment call; the BFF needs no change.",
        commits: [{ hash: head, subject: "Retry the payment call three times" }],
        commitsTotal: 1,
        files: ["src/cart.ts"],
        filesTruncated: false,
        verification: null,
      },
    ]);
    // Every word must appear, and a repo filter or a later day leaves the task out.
    expect((await search({ text: "payment refund" })).tasks).toEqual([]);
    expect((await search({ repos: ["web"] })).tasks).toEqual([]);
    expect((await search({ since: "2999-01-01" })).tasks).toEqual([]);
    const badDate = await client.callTool({ name: "search_task_history", arguments: { since: "yesterday" } });
    expect(badDate.isError).toBe(true);
  }, 60_000);
});
