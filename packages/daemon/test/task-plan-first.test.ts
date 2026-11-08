import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationEntry } from "@trackwall/protocol";
import { AGENT_MODE, PLAN_MODE } from "../src/modules/agents/acp-session-info.ts";
import type { Agents } from "../src/modules/agents/agents.ts";
import { PLAN_APPROVED_MESSAGE } from "../src/modules/agents/task-plan.ts";
import { FAKE_ACP_PLAN } from "./fixtures/fake-copilot-acp.ts";
import { makeAgents, waitFor } from "./support/agents.ts";
import { makeRepo } from "./support/git-repo.ts";

// "Plan first" for a task (ADR-227): its agent starts in Copilot CLI's Plan mode and the user approves the plan before
// it changes anything; the fake's ACP mode answers with a plan and runs no tool in Plan mode (`contract/acp-session.contract.ts`
// checks the real Copilot CLI's refusal).

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

function startAgents(dir = makeRepo({ "README.md": "# shop\n" }, "shop"), home?: string) {
  const made = makeAgents({ shop: dir }, home);
  cleanups.push(() => made.procs.stopAll());
  return { ...made, dir };
}

function sessionOf(agents: Agents, task: string): string {
  const [session, ...more] = agents.sessions().sessions.filter((s) => s.task === task && s.run.kind === "running");
  if (!session || more.length > 0) throw new Error(`task ${task} does not have exactly one running session`);
  return session.id;
}

/** The conversation and the agent's mode as the session's conversation socket sends them. */
function conversationOf(agents: Agents, session: string) {
  let entries: ConversationEntry[] = [];
  let mode: string | null = null;
  const window = agents.attachConversation(session, {
    send: (message) => {
      if (message.reset) entries = [];
      if (message.mode !== undefined) mode = message.mode?.current ?? null;
      for (const entry of message.entries) {
        const at = entries.findIndex((e) => e.id === entry.id);
        if (at >= 0) entries[at] = entry;
        else entries.push(entry);
      }
    },
    closed: () => {},
  });
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}: ${JSON.stringify({ mode, entries })}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { entries: () => entries, mode: () => mode, until, detach: () => window.detach() };
}

const turnEnded = (agents: Agents, session: string) =>
  waitFor(agents, session, (s) => s.state?.reason === "stop end_turn", "the end of the turn");

describe.skipIf(process.versions.bun === undefined)("a task that plans first (fake Copilot CLI over ACP)", () => {
  test("the task starts in Plan mode with its prompt and the rules of a plan, and the agent writes a plan without running a tool", async () => {
    const { agents } = startAgents();

    const task = await agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto", planFirst: true });

    expect(task.plan).toBe("planning");
    const session = sessionOf(agents, task.id);
    const view = conversationOf(agents, session);
    await turnEnded(agents, session);
    await view.until(() => view.entries().some((e) => e.kind === "agent"), "the plan");
    expect(view.mode()).toBe(PLAN_MODE);
    const [said, plan, ...rest] = view.entries();
    expect(said?.kind === "user" && said.text).toStartWith("Fix the login\n\n---\nPlan first:");
    expect(plan).toMatchObject({ kind: "agent", text: `${FAKE_ACP_PLAN} Fix the login` });
    expect(rest).toEqual([]);
    view.detach();
    await agents.stop(session);
  }, 60_000);

  test("approving the plan switches the agent to Agent mode, sends it the approval as the user's message, and its tools run again", async () => {
    const { agents, home } = startAgents();
    const task = await agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto", planFirst: true });
    const session = sessionOf(agents, task.id);
    await turnEnded(agents, session);
    const view = conversationOf(agents, session);

    const approved = await agents.approvePlan(task.id);

    expect(approved.plan).toBe("approved");
    expect(JSON.parse(readFileSync(join(home, "tasks.json"), "utf8")).tasks[0]).toMatchObject({ plan: "approved" });
    await view.until(() => view.entries().some((e) => e.kind === "tool"), "the implementation's tool");
    await turnEnded(agents, session);
    expect(view.mode()).toBe(AGENT_MODE);
    const users = view.entries().filter((e) => e.kind === "user");
    expect(users.at(-1)).toMatchObject({ kind: "user", text: PLAN_APPROVED_MESSAGE });
    await expect(agents.approvePlan(task.id)).rejects.toThrow("no plan waiting for approval");
    view.detach();
    await agents.stop(session);
  }, 60_000);

  test("the agent cannot report a result while its plan waits for approval, and can once the plan is approved", async () => {
    const { agents } = startAgents();
    const task = await agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto", planFirst: true });
    const session = sessionOf(agents, task.id);
    await turnEnded(agents, session);
    const report = { text: "Planned the login fix.", checkSteps: [], reproTest: null };

    await expect(agents.reportSummary(session, report)).rejects.toThrow("your plan waits for the user's approval");
    expect(agents.task(task.id)).toMatchObject({ summary: null, inReview: false });

    await agents.approvePlan(task.id);
    await turnEnded(agents, session);
    expect(await agents.reportSummary(session, report)).toMatchObject({ inReview: true });
    await agents.stop(session);
  }, 60_000);

  test("a resume while the plan waits goes on in Plan mode, also by a new daemon; after the approval it goes on in Agent mode", async () => {
    const first = startAgents();
    const task = await first.agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto", planFirst: true });
    const firstSession = sessionOf(first.agents, task.id);
    await turnEnded(first.agents, firstSession);
    await first.agents.stop(firstSession);

    const restarted = startAgents(first.dir, first.home);
    await restarted.agents.resumeTask(task.id);
    const planning = sessionOf(restarted.agents, task.id);
    await waitFor(restarted.agents, planning, (s) => s.state?.state === "Input", "the loaded conversation");
    const planningView = conversationOf(restarted.agents, planning);
    await planningView.until(() => planningView.mode() === PLAN_MODE, "the Plan mode");
    planningView.detach();
    await restarted.agents.approvePlan(task.id);
    await turnEnded(restarted.agents, planning);
    await restarted.agents.stop(planning);

    await restarted.agents.resumeTask(task.id);
    const implementing = sessionOf(restarted.agents, task.id);
    await waitFor(restarted.agents, implementing, (s) => s.state?.state === "Input", "the loaded conversation");
    const implementingView = conversationOf(restarted.agents, implementing);
    await implementingView.until(() => implementingView.mode() === AGENT_MODE, "the Agent mode");
    implementingView.detach();
    await restarted.agents.stop(implementing);
  }, 60_000);

  test("approving is refused for a task without a plan and for a task whose session is not running", async () => {
    const { agents } = startAgents();
    const plain = await agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto" });
    expect(plain.plan).toBeNull();
    await expect(agents.approvePlan(plain.id)).rejects.toThrow("no plan waiting for approval");
    await agents.stop(sessionOf(agents, plain.id));

    const planned = await agents.createTask("shop", "Fix the signup", { view: "conversation", approvals: "auto", planFirst: true });
    const session = sessionOf(agents, planned.id);
    await turnEnded(agents, session);
    await agents.stop(session);

    await expect(agents.approvePlan(planned.id)).rejects.toThrow("resume it first");
    expect(agents.task(planned.id).plan).toBe("planning");
  }, 60_000);

  test("the user cannot switch the agent out of Plan mode while the plan waits, only approve it", async () => {
    const { agents } = startAgents();
    const task = await agents.createTask("shop", "Fix the login", { view: "conversation", approvals: "auto", planFirst: true });
    const session = sessionOf(agents, task.id);
    await turnEnded(agents, session);

    await expect(agents.setMode(session, AGENT_MODE)).rejects.toThrow("press Approve plan");
    expect(agents.task(task.id).plan).toBe("planning");

    await agents.approvePlan(task.id);
    await turnEnded(agents, session);
    await agents.setMode(session, PLAN_MODE);
    await agents.stop(session);
  }, 60_000);

  test("Plan first in a terminal is refused before a worktree exists", async () => {
    const { agents, home } = startAgents();

    await expect(agents.createTask("shop", "Fix the login", { view: "terminal", planFirst: true })).rejects.toMatchObject({
      code: "bad_request",
      message: "Plan first needs the conversation view (Chat)",
    });

    expect(agents.sessions().tasks).toEqual([]);
    expect(existsSync(join(home, "task-worktrees"))).toBe(false);
  });
});
