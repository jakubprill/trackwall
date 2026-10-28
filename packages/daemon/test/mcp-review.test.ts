import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, GetReviewCommentsResult, type ReviewComment } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { untilInputBox } from "./support/screen-lines.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
});

// A limit instead of the default none: a hung cleanup on Windows is to be an error of this file, not an hour of the job.
afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function clientOfSession(session: string): Promise<Client> {
  const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session);
  clients.push(client);
  return client;
}

async function reviewComments(client: Client): Promise<ReviewComment[]> {
  const result = await client.callTool({ name: "get_review_comments", arguments: {} });
  return GetReviewCommentsResult.parse(result.structuredContent).comments;
}

function taskSession(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

const README_COMMENT: ReviewComment = {
  path: "README.md",
  side: "new",
  line: 3,
  code: "Run it with `pnpm dev`.",
  text: "Say which port it listens on.\nAnd that it needs @types/node.",
};
const LOGIN_COMMENT: ReviewComment = { path: "src/login.ts", side: "old", line: 12, code: "return null;", text: "Why did this go?" };

/** The fake's prompt line for a typed prompt: "Thinking about: <prompt>". */
const TYPED_REVIEW = "Thinking about: The user sent a review of your changes in Trackwall: call get_review_comments";

describe.skipIf(process.versions.bun === undefined)("a review from the Changes tab (real PTY and git, fake Copilot CLI)", () => {
  test("a review waits for the end of the turn, then the daemon asks the agent to read it, and the comments are read once", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe how to run shop", approvals: "ask" });
    const session = taskSession(task.id);
    // The task's session starts working on its prompt, so the review waits instead of landing in the middle of the turn.
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Working", "the task prompt's turn");

    const sent = await daemon.post(agentsApi.sendReview, { task: task.id, comments: [README_COMMENT, LOGIN_COMMENT] });

    expect(sent).toEqual({ delivery: "queued", unread: 2 });
    const window = viewer(daemon.facade.agents, session);
    // The screen image reaches a new viewer asynchronously, so the check waits for it before looking for what is not there.
    await waitFor(daemon.facade.agents, session, () => window.text().includes("--interactive="), "the screen image");
    expect(window.unwrappedText()).not.toContain(TYPED_REVIEW);
    // The fake ends a turn after a line and an approval.
    window.attachment.input("start\r");
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the approval request");
    window.attachment.input("1");
    await waitFor(daemon.facade.agents, session, () => window.unwrappedText().includes(TYPED_REVIEW), "the review prompt's turn");
    // Through the hooks' output, without typing (ADR-85): with the tool's result during the turn, and as the next turn's
    // message from the agentStop block, which the fake shows in its input line.
    expect(window.unwrappedText()).toContain("Tool result context: The user sent a review of your changes in Trackwall");
    expect(window.unwrappedText()).toContain("❯ The user sent a review of your changes in Trackwall");

    const client = await clientOfSession(session);
    expect(await reviewComments(client)).toEqual([README_COMMENT, LOGIN_COMMENT]);
    expect(await reviewComments(client)).toEqual([]);
    window.attachment.input("1");
    window.attachment.detach();
    await daemon.facade.agents.stop(session);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("a review of a task without a running session goes to the session the user resumes", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a license", approvals: "ask" });
    const first = taskSession(task.id);
    await waitFor(daemon.facade.agents, first, (s) => s.state !== null, "the first state");
    await daemon.facade.agents.stop(first);

    expect(await daemon.post(agentsApi.sendReview, { task: task.id, comments: [LOGIN_COMMENT] })).toEqual({
      delivery: "on_resume",
      unread: 1,
    });
    expect(await daemon.post(agentsApi.sendReview, { task: task.id, comments: [README_COMMENT] })).toEqual({
      delivery: "on_resume",
      unread: 2,
    });

    await daemon.post(agentsApi.resumeTask, { task: task.id });
    const resumed = taskSession(task.id);
    const window = viewer(daemon.facade.agents, resumed);
    await waitFor(daemon.facade.agents, resumed, () => window.unwrappedText().includes(TYPED_REVIEW), "the typed review prompt");
    expect(await reviewComments(await clientOfSession(resumed))).toEqual([LOGIN_COMMENT, README_COMMENT]);

    // Once the session waits in its input box again after its turn, the next review goes in at once.
    await waitFor(daemon.facade.agents, resumed, (s) => s.state?.state === "Approval", "the review turn's approval request");
    window.attachment.input("1");
    await waitFor(daemon.facade.agents, resumed, (s) => s.state?.reason === "hook agentStop", "the end of the turn");
    await untilInputBox(window, "empty");
    expect(await daemon.post(agentsApi.sendReview, { task: task.id, comments: [LOGIN_COMMENT] })).toEqual({ delivery: "typed", unread: 1 });
    window.attachment.input("1");
    window.attachment.detach();
    await daemon.facade.agents.stop(resumed);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("only a task's session has review comments, and a review of an unknown task is refused", async () => {
    const root = await daemon.facade.agents.start("shop");
    const result = await (await clientOfSession(root.id)).callTool({ name: "get_review_comments", arguments: {} });
    expect(result.content).toEqual([
      { type: "text", text: "bad_request: only a session that runs a task in Trackwall has review comments" },
    ]);
    await expect(
      daemon.post(agentsApi.sendReview, { task: "00000000-0000-4000-8000-000000000000", comments: [LOGIN_COMMENT] }),
    ).rejects.toThrow("00000000-0000-4000-8000-000000000000");
    await waitFor(daemon.facade.agents, root.id, (s) => s.state !== null, "the first state");
    await daemon.facade.agents.stop(root.id);
  }, 30_000);
});
