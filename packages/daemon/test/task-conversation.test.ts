import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationEntry, ReviewComment } from "@trackwall/protocol";
import type { Agents } from "../src/modules/agents/agents.ts";
import { makeAgents, waitFor } from "./support/agents.ts";
import { makeRepo } from "./support/git-repo.ts";

// Tasks in the conversation view (ADR-137): Copilot CLI over ACP in the task's worktree, the fake's ACP mode in place of
// the real one (`contract/acp-session.contract.ts` checks the real one).

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

function startAgents(dir = makeRepo({ "README.md": "# shop\n" }, "shop"), home?: string) {
  const made = makeAgents({ shop: dir }, home);
  cleanups.push(() => made.procs.stopAll());
  return { ...made, dir };
}

/** The task's only session; a task does not know its session, the session points to the task. */
function sessionOf(agents: Agents, task: string): string {
  const [session, ...more] = agents.sessions().sessions.filter((s) => s.task === task);
  if (!session || more.length > 0) throw new Error(`task ${task} does not have exactly one session`);
  return session.id;
}

/** The conversation the session's conversation socket sends, once it has an answer of the agent. */
async function conversationOf(agents: Agents, session: string): Promise<ConversationEntry[]> {
  let entries: ConversationEntry[] = [];
  const window = agents.attachConversation(session, {
    send: (message) => {
      if (message.reset) entries = [];
      for (const entry of message.entries) {
        const at = entries.findIndex((e) => e.id === entry.id);
        if (at >= 0) entries[at] = entry;
        else entries.push(entry);
      }
    },
    closed: () => {},
  });
  const deadline = Date.now() + 20_000;
  while (!entries.some((e) => e.kind === "agent")) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for the answer: ${JSON.stringify(entries)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  window.detach();
  return entries;
}

const turnEnded = (agents: Agents, session: string) =>
  waitFor(agents, session, (s) => s.state?.reason === "stop end_turn", "the end of the turn");

describe.skipIf(process.versions.bun === undefined)("a task in the conversation view (fake Copilot CLI over ACP)", () => {
  test("Copilot CLI starts over ACP with the prompt as the first message, the task's model and its approvals mode", async () => {
    const { agents } = startAgents();

    const task = await agents.createTask("shop", "Fix the login", { view: "conversation", model: "gpt-5", approvals: "auto" });

    expect(task).toMatchObject({ view: "conversation", model: "gpt-5", approvals: "auto" });
    expect(task).not.toHaveProperty("conversation");
    const session = sessionOf(agents, task.id);
    expect(agents.session(session)).toMatchObject({ task: task.id, view: "conversation" });
    // With `auto` the turn runs its tool without an approval.
    await turnEnded(agents, session);
    const [said, tool, answer] = await conversationOf(agents, session);
    expect(said).toMatchObject({ kind: "user", text: "Fix the login" });
    expect(tool).toMatchObject({ kind: "tool", status: "completed" });
    expect(answer?.kind === "agent" && answer.text).toContain("Argument: --model=gpt-5");
    expect(answer?.kind === "agent" && answer.text).toContain("Argument: --allow-all-tools");
    expect(answer?.kind === "agent" && answer.text).not.toContain("--interactive=");
  }, 60_000);

  test("an approved proposal starts its task in the view the user picked, and the proposer hears when its first turn ends", async () => {
    const { agents } = startAgents();
    const proposer = await agents.start("shop");
    const proposal = await agents.propose(proposer.id, {
      repo: "shop",
      title: "Fix the login",
      prompt: "Fix the login",
      model: null,
      approvals: "auto",
      item: null,
    });

    const task = await agents.approveProposal(proposal.id, proposal.prompt, null, "auto", "conversation");

    expect(task.view).toBe("conversation");
    expect(agents.session(sessionOf(agents, task.id)).view).toBe("conversation");
    const deadline = Date.now() + 20_000;
    let updates = agents.takeUpdates(proposer.id).updates;
    while (updates.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      updates = agents.takeUpdates(proposer.id).updates;
    }
    expect(updates).toEqual([{ kind: "turn_ended", task: task.id, session: sessionOf(agents, task.id), at: expect.any(String) }]);
  }, 60_000);

  test("a task that asks before tools waits for the approval in its session", async () => {
    const { agents } = startAgents();

    const task = await agents.createTask("shop", "Fix the login", { view: "conversation" });

    const session = sessionOf(agents, task.id);
    const asking = await waitFor(agents, session, (s) => s.state?.state === "Approval", "the approval");
    expect(asking.dialog).toMatchObject({ kind: "approval", question: "Do you want to allow this?" });
    await agents.stop(session);
  }, 60_000);

  test("a review sent during a turn goes as the next prompt once the turn ends", async () => {
    const { agents } = startAgents();
    const task = await agents.createTask("shop", "Fix the login", { view: "conversation" });
    const session = sessionOf(agents, task.id);
    const asking = await waitFor(agents, session, (s) => s.state?.state === "Approval", "the approval");
    const comment: ReviewComment = { path: "README.md", side: "new", line: 1, code: "# shop", text: "Name the port." };

    expect(agents.sendReview(task.id, [comment])).toEqual({ unread: 1, delivery: "queued" });
    agents.answerDialog(session, asking.dialog?.id ?? "", "1");

    const next = await waitFor(agents, session, (s) => s.dialog !== null && s.dialog.id !== asking.dialog?.id, "the review's turn");
    expect(next.state?.state).toBe("Approval");
    const users = (await conversationOf(agents, session)).filter((e) => e.kind === "user");
    expect(users).toHaveLength(2);
    expect(users[1]?.kind === "user" && users[1].text).toContain("get_review_comments");
    await agents.stop(session);
  }, 60_000);

  test("Resume loads the task's conversation, also in the next daemon, instead of sending the prompt again", async () => {
    const first = startAgents();
    const task = await first.agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto" });
    const firstSession = sessionOf(first.agents, task.id);
    await turnEnded(first.agents, firstSession);
    await first.agents.stop(firstSession);
    // The conversation's id is Copilot CLI's, saved with the task for the next daemon.
    const saved = JSON.parse(readFileSync(join(first.home, "tasks.json"), "utf8")).tasks[0];
    expect(saved).toMatchObject({ view: "conversation", conversation: expect.any(String) });

    const restarted = startAgents(first.dir, first.home);
    expect(await restarted.agents.resumeTask(task.id)).toEqual(task);

    const session = sessionOf(restarted.agents, task.id);
    await waitFor(restarted.agents, session, (s) => s.state?.state === "Input", "the loaded conversation");
    const entries = await conversationOf(restarted.agents, session);
    expect(entries.filter((e) => e.kind === "user").map((e) => e.kind === "user" && e.text)).toEqual(["Fix the login"]);
    expect(restarted.agents.session(session).view).toBe("conversation");
    await restarted.agents.stop(session);
  }, 60_000);

  test("a task whose first start never learned its conversation's id starts the conversation again from the prompt on Resume", async () => {
    const first = startAgents();
    const task = await first.agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto" });
    const firstSession = sessionOf(first.agents, task.id);
    await turnEnded(first.agents, firstSession);
    await first.agents.stop(firstSession);
    // As if the daemon had stopped before the start answered.
    const file = join(first.home, "tasks.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, tasks: [{ ...saved.tasks[0], conversation: null }] }));

    const restarted = startAgents(first.dir, first.home);
    await restarted.agents.resumeTask(task.id);

    const session = sessionOf(restarted.agents, task.id);
    await turnEnded(restarted.agents, session);
    const [said] = await conversationOf(restarted.agents, session);
    expect(said).toMatchObject({ kind: "user", text: "Fix the login" });
    await restarted.agents.stop(session);
  }, 60_000);

  test("a failed start of a new task leaves neither the task nor its worktree", async () => {
    const dir = makeRepo({ "README.md": "# shop\n" }, "shop");
    const made = makeAgents({ shop: dir }, undefined, null, undefined, { ...process.env, FAKE_COPILOT_ACP_EXIT: "1" });
    cleanups.push(() => made.procs.stopAll());

    await expect(made.agents.createTask("shop", "Fix the login", { view: "conversation" })).rejects.toThrow();

    expect(made.agents.sessions().tasks).toEqual([]);
    expect(readdirSync(join(made.home, "task-worktrees", "shop"))).toEqual([]);
  }, 60_000);

  test("a task in the conversation view cannot have Java navigation yet, and nothing of it is left", async () => {
    const { agents, home } = startAgents();

    await expect(agents.createTask("shop", "Find the callers", { view: "conversation", javaNavigation: true })).rejects.toMatchObject({
      code: "bad_request",
    });

    expect(agents.sessions().tasks).toEqual([]);
    expect(existsSync(join(home, "task-worktrees"))).toBe(false);
  });
});
