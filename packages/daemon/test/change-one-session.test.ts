import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, GetReviewCommentsResult, type Task, taskRoundsApi } from "@trackwall/protocol";
import { sessionDir } from "../src/modules/agents/session-launcher.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { gitIn } from "./support/git-repo.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "o".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      payments: { "README.md": "# payments\n" },
      "orders-api": { "README.md": "# orders-api\n" },
    },
    miseCommand: ["mise"],
  });
  // Round commits carry the user's own identity, which git takes from the repo's config here.
  for (const repo of ["payments", "orders-api"]) {
    gitIn(join(daemon.projects, repo), "config", "user.name", "Repo User");
    gitIn(join(daemon.projects, repo), "config", "user.email", "user@example.com");
  }
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

const sessionsOf = (task: string) => daemon.facade.agents.sessions().sessions.filter((s) => s.task === task);

/** A change of `payments` and `orders-api` in one session, with the lead part's running session. */
async function changeInOneSession(): Promise<{ payments: Task; orders: Task; session: string }> {
  const { tasks, failed } = await daemon.post(agentsApi.createChange, {
    title: "Refund API",
    prompt: "Add refunds to the payment flow",
    parts: [
      { repo: "payments", note: "add POST /api/refunds" },
      { repo: "orders-api", note: "call it when an order is cancelled" },
    ],
    approvals: "ask",
    sessions: "shared",
  });
  expect(failed).toEqual([]);
  const [payments, orders] = tasks;
  if (payments === undefined || orders === undefined) throw new Error("two parts expected");
  const session = sessionsOf(payments.id).find((s) => s.run.kind === "running");
  if (!session) throw new Error("the lead part has no running session");
  return { payments, orders, session: session.id };
}

/** The session's first turn under way (the user's line; the fake asks for one approval), with its terminal. */
async function inFirstTurn(session: string) {
  const terminal = viewer(daemon.facade.agents, session);
  terminal.attachment.input("start\r");
  await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the first turn's approval");
  return terminal;
}

/** Ends the change: the session first, then the parts its session worked on, then the lead part. */
async function endChange({ payments, orders, session }: { payments: Task; orders: Task; session: string }): Promise<void> {
  await daemon.facade.agents.stop(session);
  await daemon.post(agentsApi.removeTask, { task: orders.id, keepBranch: false, discardChanges: true });
  await daemon.post(agentsApi.removeTask, { task: payments.id, keepBranch: false, discardChanges: true });
}

describe.skipIf(process.versions.bun === undefined)("a change in one session (ADR-265; real PTY and git, fake Copilot CLI)", () => {
  test("starts one session in a folder that holds a worktree per repo, with the whole prompt and every part named", async () => {
    const change = await changeInOneSession();
    const { payments, orders, session } = change;

    // A task per repo as before, on one branch name, each naming the lead part, whose session works on both.
    expect([payments.change?.session, orders.change?.session]).toEqual([payments.id, payments.id]);
    expect(orders.branch).toBe(payments.branch);
    expect(sessionsOf(orders.id)).toEqual([]);
    // One folder for the change, with each part's worktree under its repo's name.
    const folder = dirname(payments.worktree);
    expect(folder).toMatch(/_changes[\\/]refund-api-[0-9a-f]{6}$/);
    expect(payments.worktree).toBe(join(folder, "payments"));
    expect(orders.worktree).toBe(join(folder, "orders-api"));
    expect(gitIn(orders.worktree, "branch", "--show-current").trim()).toBe(payments.branch);
    // The session runs in that folder, and its prompt is the change's with every part's note.
    const window = viewer(daemon.facade.agents, session);
    await waitFor(daemon.facade.agents, session, () => window.text().includes("--interactive="), "the prompt on the screen");
    expect(window.unwrappedText()).toContain(`Directory:${realpathSync(folder)}`);
    expect(payments.prompt).toBe(
      "Add refunds to the payment flow\n\nIn payments: add POST /api/refunds\n\nIn orders-api: call it when an order is cancelled",
    );
    expect(orders.prompt).toBe("Add refunds to the payment flow\n\nIn orders-api: call it when an order is cancelled");

    const text = readFileSync(join(sessionDir(daemon.home, session), "instructions", "trackwall.instructions.md"), "utf8");
    expect(text).toContain(
      `You run one change across 2 repos in this one session. The folder you are in holds a git worktree per repo, each on the branch \`${payments.branch}\`, and each is a task in Trackwall that the user reviews on its own, their merge requests to be merged in this order:\n` +
        `  1. folder \`payments\`: the repo \`payments\` (its id in Trackwall tools), task \`${payments.id}\`\n` +
        `  2. folder \`orders-api\`: the repo \`orders-api\` (its id in Trackwall tools), task \`${orders.id}\`\n`,
    );
    expect(text).toContain("- Do not commit, switch branches, push, merge or open merge requests");
    // No tool guide and no handoff: one conversation has nobody to coordinate with.
    expect(text).not.toContain("## Trackwall tools");
    expect(text).not.toContain("get_handoff");

    await endChange(change);
    // The change's folder goes with its last part.
    expect(existsSync(folder)).toBe(false);
  }, 60_000);

  test("a turn of the session is a round with a commit in every part it changed, and its one report hands every part over", async () => {
    const change = await changeInOneSession();
    const { payments, orders, session } = change;
    const terminal = await inFirstTurn(session);
    // The turn's start is read from each part's worktree in the background; once the rounds come back it is known.
    expect(await daemon.post(taskRoundsApi.rounds, { task: orders.id })).toMatchObject({ rounds: [] });
    expect(await daemon.post(taskRoundsApi.rounds, { task: payments.id })).toMatchObject({ rounds: [] });

    // The agent changes both repos and leaves the files uncommitted; the turn ends with the approval.
    writeFileSync(join(payments.worktree, "refunds.ts"), "export const refunds = [];\n");
    writeFileSync(join(orders.worktree, "cancel.ts"), "export const cancel = () => {};\n");
    terminal.attachment.input("1");
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Input", "the end of the turn");
    for (const part of [payments, orders]) {
      const until = Date.now() + 20_000;
      while ((await daemon.post(taskRoundsApi.rounds, { task: part.id })).rounds.length === 0) {
        if (Date.now() > until) throw new Error(`gave up waiting for round 1 of ${part.repo}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(gitIn(part.worktree, "log", "-1", "--format=%s|%an").trim()).toBe("WIP round 1|Repo User");
      expect(gitIn(part.worktree, "status", "--porcelain")).toBe("");
    }
    // Each part's changes are its own repo's.
    expect((await daemon.post(agentsApi.taskChanges, { task: payments.id })).files.map((f) => f.path)).toEqual(["refunds.ts"]);
    expect((await daemon.post(agentsApi.taskChanges, { task: orders.id })).files.map((f) => f.path)).toEqual(["cancel.ts"]);

    const client = await connectSessionClient(daemon.api.port, daemon.home, session);
    clients.push(client);
    await client.callTool({ name: "report_result", arguments: { summary: "Refunds added in payments and called from orders-api." } });
    const listed = daemon.facade.agents.tasks().filter((t) => t.change?.id === payments.change?.id);
    expect(listed.map((t) => [t.repo, t.summary?.text, t.inReview]).sort()).toEqual([
      ["orders-api", "Refunds added in payments and called from orders-api.", true],
      ["payments", "Refunds added in payments and called from orders-api.", true],
    ]);

    await endChange(change);
  }, 90_000);

  test("a review or a resume of a part without a session reaches the one session, and the lead part does not end before the others", async () => {
    const change = await changeInOneSession();
    const { payments, orders, session } = change;
    await inFirstTurn(session);

    // The user reviews the part that has no session of its own: the session that works on it is asked to read.
    const comment = { path: "cancel.ts", side: "new" as const, line: 1, code: "export const cancel", text: "Name the order." };
    const sent = await daemon.post(agentsApi.sendReview, { task: orders.id, comments: [comment] });
    expect(sent.delivery).not.toBe("on_resume");
    const client = await connectSessionClient(daemon.api.port, daemon.home, session);
    clients.push(client);
    const review = GetReviewCommentsResult.parse((await client.callTool({ name: "get_review_comments", arguments: {} })).structuredContent);
    expect(review.comments).toEqual([]);
    expect(review.otherParts).toEqual([
      { task: orders.id, repo: "orders-api", comments: [comment], pipelineFix: null, mergeRequestComments: null },
    ]);

    // The lead part cannot go while its session works on the other part.
    await daemon.facade.agents.stop(session);
    await expect(daemon.post(agentsApi.removeTask, { task: payments.id, keepBranch: false, discardChanges: true })).rejects.toThrow(
      "the session of this part works on the other parts of its change too (orders-api); end those parts first",
    );
    // Resuming the part without a session goes on with the one conversation, the lead part's, again in the change's folder.
    await daemon.post(agentsApi.resumeTask, { task: orders.id });
    const resumed = sessionsOf(payments.id).find((s) => s.run.kind === "running");
    if (!resumed) throw new Error("the lead part has no session after its resume");
    const window = viewer(daemon.facade.agents, resumed.id);
    await waitFor(daemon.facade.agents, resumed.id, () => window.text().includes("--resume="), "the resume on the screen");
    expect(window.unwrappedText()).toContain(`Directory:${realpathSync(dirname(payments.worktree))}`);

    await endChange({ payments, orders, session: resumed.id });
  }, 90_000);
});
