import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, GetHandoffResult, GetUpdatesResult, ProposeTaskResult } from "@trackwall/protocol";
import { sessionDir } from "../src/modules/agents/session-launcher.ts";
import { TaskFile } from "../src/modules/agents/task-file.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "c".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      payments: { "README.md": "# payments\n" },
      "orders-api": { "README.md": "# orders-api\n" },
      "shop-web": { "README.md": "# shop-web\n" },
    },
    miseCommand: ["mise"],
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

function runningSession(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

function instructionsOf(session: string): string {
  return readFileSync(join(sessionDir(daemon.home, session), "instructions", "trackwall.instructions.md"), "utf8");
}

async function endAll(tasks: readonly { id: string }[]): Promise<void> {
  for (const { id } of tasks) {
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === id && s.run.kind === "running");
    if (session) await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: id, keepBranch: false, discardChanges: true });
  }
}

describe.skipIf(process.versions.bun === undefined)("a change across several repos (ADR-171; real PTY and git, fake Copilot CLI)", () => {
  test("starts one task per repo on one branch name, in the merge order, each with the change's prompt and its own note", async () => {
    const { tasks, failed } = await daemon.post(agentsApi.createChange, {
      title: "Refund API",
      prompt: "Add refunds to the payment flow",
      parts: [
        { repo: "payments", note: "add POST /api/refunds" },
        { repo: "orders-api", note: "" },
      ],
      approvals: "ask",
    });

    expect(failed).toEqual([]);
    const [payments, orders] = tasks;
    if (payments === undefined || orders === undefined) throw new Error("two parts expected");
    expect(tasks.map((t) => t.repo)).toEqual(["payments", "orders-api"]);
    expect(payments.change?.id).toBe(orders.change?.id ?? "");
    expect(tasks.map((t) => t.change?.position)).toEqual([0, 1]);
    // One branch name, from the change's title and id, in both repos.
    expect(payments.branch).toMatch(/^trackwall\/refund-api-[0-9a-f]{6}$/);
    expect(orders.branch).toBe(payments.branch);
    expect(gitIn(orders.worktree, "branch", "--show-current").trim()).toBe(payments.branch.trim());
    expect(payments.title).toBe("Refund API");
    expect(payments.prompt).toBe("Add refunds to the payment flow\n\nIn payments: add POST /api/refunds");
    expect(orders.prompt).toBe("Add refunds to the payment flow");
    // Neither part proposed the other: the user started both, so neither reports to the other.
    expect(tasks.map((t) => t.proposedBy)).toEqual([null, null]);
    // The change survives a daemon restart with its tasks.
    const stored = new TaskFile(join(daemon.home, "tasks.json"), () => {}).read();
    const storedParts = stored.filter((t) => t.change?.id === payments.change?.id);
    expect(storedParts.map((t) => [t.repo, t.change?.position]).sort()).toEqual([
      ["orders-api", 1],
      ["payments", 0],
    ]);

    await endAll(tasks);
  }, 60_000);

  test("each part's session knows its siblings, and a later part reads the part before it with get_handoff", async () => {
    const { tasks } = await daemon.post(agentsApi.createChange, {
      title: "Refund API",
      prompt: "Add refunds",
      parts: [{ repo: "payments" }, { repo: "orders-api" }, { repo: "shop-web" }],
      approvals: "ask",
    });
    const [payments, orders, web] = tasks;
    if (payments === undefined || orders === undefined || web === undefined) throw new Error("three parts expected");
    const ordersSession = runningSession(orders.id);
    const text = instructionsOf(ordersSession);
    expect(text).toContain(
      `- Your task is part 2 of 3 of one change across several repos: each part is a task in its own repo, all on the branch \`${payments.branch}\`, and their merge requests are to be merged in this order:\n` +
        `  1. the repo \`payments\`, task \`${payments.id}\`\n` +
        `  2. the repo \`orders-api\`, task \`${orders.id}\` (yours)\n` +
        `  3. the repo \`shop-web\`, task \`${web.id}\`\n`,
    );
    // Each part builds on the one right before it: orders-api on payments, shop-web on orders-api.
    expect(text).toContain(`- Your part builds on the part before it, the task \`${payments.id}\` in the repo \`payments\``);
    expect(instructionsOf(runningSession(web.id))).toContain(`the part before it, the task \`${orders.id}\` in the repo \`orders-api\``);
    expect(instructionsOf(runningSession(payments.id))).not.toContain("builds on the part before it");

    commitFiles(payments.worktree, { "openapi.yaml": "paths:\n  /api/refunds:\n    post: {}\n" }, "Add refunds");
    const head = gitIn(payments.worktree, "rev-parse", "HEAD").trim();
    const client = await connectSessionClient(daemon.api.port, daemon.home, ordersSession);
    clients.push(client);
    const handoff = GetHandoffResult.parse((await client.callTool({ name: "get_handoff", arguments: {} })).structuredContent).handoff;
    expect(handoff).toMatchObject({ task: payments.id, repo: "payments", read: payments.base, head, commits: 1, files: ["openapi.yaml"] });

    // An ended part leaves its siblings, which are told so at their next start.
    await endAll([payments]);
    await daemon.facade.agents.stop(ordersSession);
    await daemon.post(agentsApi.resumeTask, { task: orders.id });
    const resumed = instructionsOf(runningSession(orders.id));
    expect(resumed).toContain("part 1 of 2");
    expect(resumed).toContain(
      `The part before yours, the task \`${payments.id}\` in the repo \`payments\`, is no longer on Trackwall's list`,
    );

    await endAll([orders, web]);
  }, 60_000);

  test("a part that cannot start is named while the others run, and two parts in one repo are refused before any starts", async () => {
    const { tasks, failed } = await daemon.post(agentsApi.createChange, {
      title: "Refund API",
      prompt: "Add refunds",
      parts: [{ repo: "payments" }, { repo: "billing" }, { repo: "shop-web" }],
      approvals: "ask",
    });
    expect(tasks.map((t) => [t.repo, t.change?.position])).toEqual([
      ["payments", 0],
      ["shop-web", 2],
    ]);
    expect(failed.map((f) => f.repo)).toEqual(["billing"]);
    // shop-web builds on payments, the part before it that started.
    expect(instructionsOf(runningSession(tasks[1]?.id ?? ""))).toContain(
      `the part before it, the task \`${tasks[0]?.id ?? ""}\` in the repo \`payments\``,
    );
    await endAll(tasks);

    const before = daemon.facade.agents.sessions().tasks.length;
    await expect(
      daemon.post(agentsApi.createChange, {
        title: "Twice",
        prompt: "Add refunds",
        parts: [{ repo: "payments" }, { repo: "payments" }],
        approvals: "ask",
      }),
    ).rejects.toThrow("a change has one part per repo");
    expect(daemon.facade.agents.sessions().tasks.length).toBe(before);
  }, 60_000);
  test("an agent proposes a change on one card, the user unticks a repo, and the proposer hears which parts started", async () => {
    const main = await daemon.facade.agents.start("payments");
    const client = await connectSessionClient(daemon.api.port, daemon.home, main.id);
    clients.push(client);
    const { proposal } = ProposeTaskResult.parse(
      (
        await client.callTool({
          name: "propose_change",
          arguments: {
            title: "Refund API",
            prompt: "Add refunds",
            parts: [
              { repo: "payments", note: "add POST /api/refunds" },
              { repo: "orders-api", note: "call it on cancel" },
              { repo: "shop-web" },
            ],
          },
        })
      ).structuredContent,
    );
    expect(proposal).toMatchObject({
      kind: "change",
      repo: "payments",
      title: "Refund API",
      parts: [
        { repo: "payments", note: "add POST /api/refunds" },
        { repo: "orders-api", note: "call it on cancel" },
        { repo: "shop-web", note: "" },
      ],
      proposedBy: { session: main.id, supervisor: false, task: null },
    });
    // Neither one task's approval nor fewer than two repos start it; the proposal waits.
    await expect(
      daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: "Add refunds", model: null, approvals: "ask" }),
    ).rejects.toThrow(`proposal ${proposal.id} is not a task`);
    const approve = (repos: string[]) =>
      daemon.post(agentsApi.approveChangeProposal, {
        proposal: proposal.id,
        prompt: "Add refunds, idempotently",
        repos,
        model: null,
        approvals: "ask",
      });
    await expect(approve(["payments", "billing"])).rejects.toThrow("billing is not a part of the proposed change");
    expect(daemon.facade.agents.sessions().proposals.map((p) => p.id)).toEqual([proposal.id]);

    const { tasks, failed } = await approve(["shop-web", "payments"]);

    expect(failed).toEqual([]);
    // The proposal's order, not the request's; the first part takes the proposal's id, and every part its proposer.
    expect(tasks.map((t) => [t.repo, t.change?.position, t.prompt])).toEqual([
      ["payments", 0, "Add refunds, idempotently\n\nIn payments: add POST /api/refunds"],
      ["shop-web", 1, "Add refunds, idempotently"],
    ]);
    expect(tasks[0]?.id).toBe(proposal.id);
    expect(tasks.map((t) => t.proposedBy)).toEqual([proposal.proposedBy, proposal.proposedBy]);
    expect(tasks[1]?.branch).toBe(tasks[0]?.branch ?? "");
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);
    const { updates } = GetUpdatesResult.parse((await client.callTool({ name: "get_updates", arguments: {} })).structuredContent);
    expect(updates[0]).toEqual({
      kind: "change_started",
      task: proposal.id,
      session: null,
      parts: tasks.map((t) => ({ task: t.id, repo: t.repo })),
      failed: [],
      at: expect.any(String),
    });

    // A part's own session proposes the work of other repos as subtasks, not as a change.
    const partClient = await connectSessionClient(daemon.api.port, daemon.home, runningSession(tasks[1]?.id ?? ""));
    clients.push(partClient);
    const refused = await partClient.callTool({
      name: "propose_change",
      arguments: { title: "More", prompt: "More", parts: [{ repo: "payments" }, { repo: "orders-api" }] },
    });
    expect(refused.content).toEqual([
      {
        type: "text",
        text: "bad_request: a task proposes the work in other repos with propose_task, one proposal per repo, so that each reads your handoff",
      },
    ]);

    await endAll(tasks);
    await daemon.facade.agents.stop(main.id);
  }, 60_000);
});
