import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { TaskHistoryResult } from "@trackwall/protocol";
import { waitUntil } from "../src/platform/process-group.ts";
import { viewer, waitFor } from "./support/agents.ts";
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
  // Round commits (ADR-168) carry the user's own identity, which git takes from the repo's config here.
  gitIn(join(daemon.projects, "shop"), "config", "user.name", "Repo User");
  gitIn(join(daemon.projects, "shop"), "config", "user.email", "user@example.com");
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
    await agents.reportSummary(session.id, { text: "Retries the payment call; the BFF needs no change.", checkSteps: [], reproTest: null });
    await agents.stop(session.id);

    await agents.removeTask(task.id, true, false);
    // The record is written after the task has ended, without holding up the end.
    expect(await waitUntil(() => existsSync(join(daemon.home, "task-journal.jsonl")), 5000)).toBe(true);

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
        retryOf: null,
        summary: "Retries the payment call; the BFF needs no change.",
        commits: [{ hash: head, subject: "Retry the payment call three times" }],
        commitsTotal: 1,
        files: ["src/cart.ts"],
        filesTruncated: false,
        verification: null,
        model: null,
        // The fake Copilot CLI writes no event log in the user's own Copilot CLI home here.
        usage: null,
        models: [],
      },
    ]);
    // Every word must appear, and a repo filter or a later day leaves the task out.
    expect((await search({ text: "payment refund" })).tasks).toEqual([]);
    expect((await search({ repos: ["web"] })).tasks).toEqual([]);
    expect((await search({ since: "2999-01-01" })).tasks).toEqual([]);
    const badDate = await client.callTool({ name: "search_task_history", arguments: { since: "yesterday" } });
    expect(badDate.isError).toBe(true);
  }, 60_000);

  test("a task whose worktree was removed by hand still leaves the commits of its branch", async () => {
    const agents = daemon.facade.agents;
    const task = await agents.createTask("shop", "Rename the cart");
    writeFileSync(join(task.worktree, "src", "cart.ts"), "export const basket = [];\n");
    gitIn(task.worktree, "commit", "-qam", "Rename the cart to basket");
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (!session) throw new Error("the task has no session");
    await agents.stop(session.id);
    rmSync(task.worktree, { recursive: true, force: true });

    await agents.removeTask(task.id, false, true);
    const journal = join(daemon.home, "task-journal.jsonl");
    expect(await waitUntil(() => readFileSync(journal, "utf8").includes(task.id), 5000)).toBe(true);

    const found = TaskHistoryResult.parse(
      (await client.callTool({ name: "search_task_history", arguments: { text: "basket" } })).structuredContent,
    );
    expect(found.tasks).toMatchObject([
      { task: task.id, branchKept: false, commits: [{ subject: "Rename the cart to basket" }], commitsTotal: 1, files: ["src/cart.ts"] },
    ]);
  }, 60_000);
  test("the record lists the agent's own commits, not the WIP round commits Trackwall made at the end of its turns (ADR-168)", async () => {
    const agents = daemon.facade.agents;
    const task = await agents.createTask("shop", "Empty the cart on logout");
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (!session) throw new Error("the task has no session");
    // The agent commits its work, then a turn ends with a change left uncommitted: Trackwall commits it as a round.
    writeFileSync(join(task.worktree, "src", "cart.ts"), "export const cart = [];\nexport const emptyOnLogout = true;\n");
    gitIn(task.worktree, "commit", "-qam", "Empty the cart on logout");
    const terminal = viewer(agents, session.id);
    terminal.attachment.input("start\r");
    await waitFor(agents, session.id, (s) => s.state?.state === "Approval", "the turn's approval");
    writeFileSync(join(task.worktree, "README.md"), "# shop\n\nThe cart empties on logout.\n");
    terminal.attachment.input("1");
    expect(await waitUntil(() => gitIn(task.worktree, "log", "-1", "--format=%s").startsWith("WIP round 1"), 20_000)).toBe(true);
    terminal.attachment.detach();
    await agents.stop(session.id);

    await agents.removeTask(task.id, true, false);
    const journal = join(daemon.home, "task-journal.jsonl");
    expect(await waitUntil(() => readFileSync(journal, "utf8").includes(task.id), 5000)).toBe(true);

    const found = TaskHistoryResult.parse(
      (await client.callTool({ name: "search_task_history", arguments: { text: "logout" } })).structuredContent,
    );
    expect(found.tasks).toMatchObject([
      { task: task.id, commits: [{ subject: "Empty the cart on logout" }], commitsTotal: 2, files: ["README.md", "src/cart.ts"] },
    ]);
  }, 60_000);
});
