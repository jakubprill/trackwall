import { describe, expect, setSystemTime, test } from "bun:test";
import type { ProposedBy, Session, Task, TaskState, Verification } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import { inboxPrompt } from "../src/modules/agents/inbox-prompt.ts";
import { proposedByOf, proposerKeyOf, SUPERVISOR as SUPERVISOR_WORK } from "../src/modules/agents/proposer.ts";
import { type CoordinatedSession, TaskCoordination } from "../src/modules/agents/task-coordination.ts";
import { TaskMessages } from "../src/modules/agents/task-messages.ts";
import { TaskUpdates } from "../src/modules/agents/task-updates.ts";

const MAIN = "11111111-1111-4111-8111-111111111111";
const SUPERVISOR = "22222222-2222-4222-8222-222222222222";
const NEW_SUPERVISOR = "33333333-3333-4333-8333-333333333333";
const TASK_SESSION = "44444444-4444-4444-8444-444444444444";
const BY_MAIN: ProposedBy = { session: MAIN, supervisor: false };
const BY_SUPERVISOR: ProposedBy = { session: SUPERVISOR, supervisor: true };

function task(id: string, proposedBy: ProposedBy | null): Task {
  return {
    id,
    repo: "shop",
    prompt: "fix login",
    branch: `trackwall/fix-login-${id}`,
    baseBranch: "main",
    base: "a".repeat(40),
    worktree: `/state/worktrees/shop/${id}`,
    createdAt: "2026-10-25T12:00:00.000Z",
    title: "Fix login",
    proposedBy,
    summary: null,
    port: 41000,
    included: { files: [], problems: [] },
  };
}

function view(id: string, taskId: string | null, state: TaskState | null, run: Session["run"] = RUNNING): Session {
  return {
    id,
    repo: taskId === null && id !== MAIN ? null : "shop",
    startedAt: "2026-10-25T12:00:00.000Z",
    run,
    state: state && { state, source: "hook", confidence: "high", reason: "hook", at: "2026-10-25T12:00:00.000Z" },
    windowTitle: null,
    needsAttention: false,
    task: taskId,
    dialog: null,
  };
}

const RUNNING: Session["run"] = { kind: "running", runId: "r1", startedAt: "2026-10-25T12:00:00.000Z", pid: 1 };

/**
 * Coordination on fakes of the rest of `agents`: tasks `by-main` (proposed by the main session), `by-supervisor` (by an
 * earlier supervisor) and `by-user` (typed in the UI); sessions MAIN, SUPERVISOR and the task session of `by-main`.
 * Every `askToRead` is recorded by session.
 */
function setup() {
  const tasks = new Map([
    ["by-main", task("by-main", BY_MAIN)],
    ["by-supervisor", task("by-supervisor", BY_SUPERVISOR)],
    ["by-user", task("by-user", null)],
    ["by-outside", task("by-outside", { session: null, supervisor: false })],
  ]);
  const sessions = new Map([
    [MAIN, view(MAIN, null, "Input")],
    [SUPERVISOR, view(SUPERVISOR, null, "Input")],
    [NEW_SUPERVISOR, view(NEW_SUPERVISOR, null, "Input")],
    [TASK_SESSION, view(TASK_SESSION, "by-main", "Working")],
  ]);
  const asked: string[] = [];
  const running = new Set([MAIN, TASK_SESSION, SUPERVISOR]);
  const live = (id: string): CoordinatedSession => ({
    id,
    askToRead: () => {
      asked.push(id);
      return "queued";
    },
  });
  const coordination = new TaskCoordination({
    task: (id) => {
      const found = tasks.get(id);
      if (!found) throw new DomainError("not_found", `no task ${id}`);
      return found;
    },
    findTask: (id) => tasks.get(id),
    proposedBy: (id) => {
      const found = sessions.get(id);
      if (!found) throw new DomainError("not_found", `no session ${id}`);
      return proposedByOf(found);
    },
    proposerKey: (id) => {
      const found = sessions.get(id);
      if (!found) throw new DomainError("not_found", `no session ${id}`);
      return proposerKeyOf(found);
    },
    runningOfTask: (id) => (id === "by-main" && running.has(TASK_SESSION) ? live(TASK_SESSION) : undefined),
    runningProposer: (key) =>
      key === SUPERVISOR_WORK
        ? [SUPERVISOR, NEW_SUPERVISOR].filter((id) => running.has(id)).map(live)[0]
        : running.has(key)
          ? live(key)
          : undefined,
    hasProposer: (key) => key === SUPERVISOR_WORK || sessions.has(key),
    log: () => {},
  });
  return { coordination, tasks, asked, running };
}

describe("messages to a task's session", () => {
  test("the proposer's message is queued for the task's session, which is asked to read it, and it is read once", () => {
    const { coordination, asked } = setup();

    const sent = coordination.send(MAIN, "by-main", "Also keep the old endpoint.");

    expect(sent).toMatchObject({
      delivery: "queued",
      message: { task: "by-main", from: BY_MAIN, text: "Also keep the old endpoint.", readAt: null },
    });
    expect(asked).toEqual([TASK_SESSION]);
    expect(coordination.unread({ id: TASK_SESSION, repo: "shop", task: "by-main" }).messages).toBe(1);
    expect(coordination.takeMessages("by-main").map((m) => m.text)).toEqual(["Also keep the old endpoint."]);
    expect(coordination.takeMessages("by-main")).toEqual([]);
    expect(coordination.messages()).toEqual([expect.objectContaining({ text: "Also keep the old endpoint.", readAt: expect.any(String) })]);
  });

  test("a task without a running session gets the message when the user resumes it", () => {
    const { coordination, running } = setup();
    running.delete(TASK_SESSION);

    expect(coordination.send(MAIN, "by-main", "Rebase first.").delivery).toBe("on_resume");
  });

  test("only the proposer sends: another session, an agent outside Trackwall and anyone writing to a task the user started are refused", () => {
    const { coordination } = setup();

    expect(() => coordination.send(SUPERVISOR, "by-main", "Hi")).toThrow("task by-main was proposed by another session");
    expect(() => coordination.send(null, "by-main", "Hi")).toThrow("an agent outside Trackwall sends no messages");
    expect(() => coordination.send(null, "by-outside", "Hi")).toThrow("an agent outside Trackwall sends no messages");
    expect(() => coordination.send(MAIN, "by-user", "Hi")).toThrow("the user started task by-user");
    expect(() => coordination.send(MAIN, "missing", "Hi")).toThrow("no task missing");
  });

  test("the supervisor's work takes messages from whichever supervisor runs now", () => {
    const { coordination } = setup();

    expect(coordination.send(NEW_SUPERVISOR, "by-supervisor", "Use the new DTO.").message.from).toEqual({
      session: NEW_SUPERVISOR,
      supervisor: true,
    });
    expect(() => coordination.send(MAIN, "by-supervisor", "Hi")).toThrow("proposed by another session");
  });

  test("after five messages without the user the sixth is refused, until the user types into the sender's session", () => {
    const { coordination } = setup();
    for (let i = 1; i <= 5; i++) coordination.send(MAIN, "by-main", `Step ${i}`);

    expect(() => coordination.send(MAIN, "by-main", "Step 6")).toThrow(
      "5 messages went to task by-main since the user last took part; ask the user before you send more",
    );
    try {
      tenMillisecondsLater();
      coordination.userTyped({ id: MAIN, task: null });
      tenMillisecondsLater();
      expect(coordination.send(MAIN, "by-main", "Step 6").message.text).toBe("Step 6");
    } finally {
      setSystemTime();
    }
  });

  test("typing into the task's session or a review of the task also counts as the user taking part", () => {
    const { coordination } = setup();
    const fill = () => {
      for (let i = 0; i < 5; i++) coordination.send(MAIN, "by-main", "More");
      coordination.takeMessages("by-main");
    };
    try {
      fill();
      tenMillisecondsLater();
      coordination.userTyped({ id: TASK_SESSION, task: "by-main" });
      // The task's session closed and resumed in a new one: the user still took part in the task.
      coordination.sessionClosed({ id: TASK_SESSION, repo: "shop" });
      tenMillisecondsLater();
      fill();
      tenMillisecondsLater();
      coordination.reviewed("by-main");
      tenMillisecondsLater();
      expect(coordination.send(MAIN, "by-main", "Last").message.text).toBe("Last");
    } finally {
      setSystemTime();
    }
  });

  test("an ended task takes its messages with it", () => {
    const { coordination } = setup();
    coordination.send(MAIN, "by-main", "Hi");

    coordination.taskEnded("by-main");

    expect(coordination.messages()).toEqual([]);
    expect(coordination.unread({ id: TASK_SESSION, repo: "shop", task: "by-main" }).messages).toBe(0);
  });
});

describe("updates on delegated work", () => {
  test("a turn the agent worked on ends, the proposer is asked to read it, and the updates are read once", () => {
    const { coordination, asked } = setup();
    coordination.sessionEvent({ id: TASK_SESSION, task: "by-main" }, { kind: "turn_ended" });

    expect(asked).toEqual([MAIN]);
    expect(coordination.unread({ id: MAIN, repo: "shop", task: null }).updates).toBe(1);
    expect(coordination.takeUpdates(MAIN)).toEqual({
      updates: [{ kind: "turn_ended", task: "by-main", session: TASK_SESSION, at: expect.any(String) }],
      dropped: 0,
    });
    expect(coordination.takeUpdates(MAIN)).toEqual({ updates: [], dropped: 0 });
  });

  test("a result, a verdict and a rejection go to the proposer; the supervisor's to the supervisor running now", () => {
    const { coordination, tasks, asked, running } = setup();
    const reported = { ...task("by-main", BY_MAIN), summary: { text: "Fixed and tested.", reportedAt: "2026-10-25T13:00:00.000Z" } };
    tasks.set("by-main", reported);
    running.delete(SUPERVISOR);
    running.add(NEW_SUPERVISOR);

    coordination.resultReported(reported, TASK_SESSION);
    coordination.verificationFinished({ ...verification("by-supervisor"), state: "running" });
    coordination.verificationFinished({ ...verification("by-supervisor"), state: "failed", message: "mise task test exited with code 1" });
    coordination.proposalRejected({ id: "p1", proposedBy: BY_SUPERVISOR }, "Not now");

    expect(asked).toEqual([MAIN, NEW_SUPERVISOR, NEW_SUPERVISOR]);
    expect(coordination.takeUpdates(MAIN).updates).toEqual([
      { kind: "result_reported", task: "by-main", session: TASK_SESSION, summary: "Fixed and tested.", at: "2026-10-25T13:00:00.000Z" },
    ]);
    expect(coordination.takeUpdates(NEW_SUPERVISOR).updates).toEqual([
      {
        kind: "verified",
        task: "by-supervisor",
        session: null,
        state: "failed",
        message: "mise task test exited with code 1",
        at: expect.any(String),
      },
      { kind: "proposal_rejected", task: "p1", session: null, reason: "Not now", at: expect.any(String) },
    ]);
  });

  test("work nobody in Trackwall proposed gives no updates, and an agent outside Trackwall cannot read any", () => {
    const { coordination, asked } = setup();
    coordination.sessionEvent({ id: TASK_SESSION, task: "by-user" }, { kind: "turn_ended" });
    coordination.proposalRejected({ id: "p2", proposedBy: { session: null, supervisor: false } }, null);

    expect(asked).toEqual([]);
    expect(() => coordination.takeUpdates(null)).toThrow(
      "an agent outside Trackwall gets no updates; follow its tasks with wait_for_session",
    );
  });

  test("an error and the end of the process go to the proposer", () => {
    const { coordination } = setup();
    const session = { id: TASK_SESSION, task: "by-main" };

    coordination.sessionEvent(session, { kind: "error" });
    coordination.sessionEvent(session, { kind: "exited", exitCode: null, stoppedByUser: true });

    expect(coordination.takeUpdates(MAIN).updates).toEqual([
      { kind: "error", task: "by-main", session: TASK_SESSION, at: expect.any(String) },
      { kind: "exited", exitCode: null, stoppedByUser: true, task: "by-main", session: TASK_SESSION, at: expect.any(String) },
    ]);
  });

  test("a proposer the user has closed gets nothing queued", () => {
    const gone = "55555555-5555-4555-8555-555555555555";
    const tasks = new Map([["by-gone", task("by-gone", { session: gone, supervisor: false })]]);
    const coordination = new TaskCoordination({
      task: () => task("by-gone", null),
      findTask: (id) => tasks.get(id),
      proposedBy: () => BY_MAIN,
      proposerKey: () => MAIN,
      runningOfTask: () => undefined,
      runningProposer: () => undefined,
      hasProposer: () => false,
      log: () => {},
    });

    coordination.sessionEvent({ id: TASK_SESSION, task: "by-gone" }, { kind: "turn_ended" });

    expect(coordination.unread({ id: gone, repo: "shop", task: null }).updates).toBe(0);
  });

  test("a closed main session's updates go with it, the supervisor's stay for the next supervisor", () => {
    const { coordination } = setup();
    coordination.proposalRejected({ id: "p1", proposedBy: BY_MAIN }, null);
    coordination.proposalRejected({ id: "p2", proposedBy: BY_SUPERVISOR }, null);

    coordination.sessionClosed({ id: MAIN, repo: "shop" });
    coordination.sessionClosed({ id: SUPERVISOR, repo: null });

    expect(coordination.unread({ id: MAIN, repo: "shop", task: null }).updates).toBe(0);
    expect(coordination.takeUpdates(NEW_SUPERVISOR).updates.map((u) => u.task)).toEqual(["p2"]);
  });
});

describe("the kept messages and updates", () => {
  test("read messages make room for new ones; with 20 unread a new one is refused", () => {
    const messages = new TaskMessages();
    for (let i = 0; i < 20; i++) messages.add("t1", BY_MAIN, `m${i}`, Number.POSITIVE_INFINITY);
    messages.take("t1");
    messages.add("t1", BY_MAIN, "m20", Number.POSITIVE_INFINITY);

    expect(messages.list().map((m) => m.text)).toEqual([...Array.from({ length: 19 }, (_, i) => `m${i + 1}`), "m20"]);
    for (let i = 21; i < 40; i++) messages.add("t1", BY_MAIN, `m${i}`, Number.POSITIVE_INFINITY);
    expect(() => messages.add("t1", BY_MAIN, "m40", Number.POSITIVE_INFINITY)).toThrow("20 messages to task t1 are still unread");
  });

  test("beyond 50 unread updates the oldest drop out and are counted", () => {
    const updates = new TaskUpdates();
    for (let i = 0; i < 53; i++) updates.add(MAIN, { kind: "turn_ended", task: `t${i}`, session: null, at: "2026-10-25T12:00:00.000Z" });

    const taken = updates.take(MAIN);

    expect(taken.dropped).toBe(3);
    expect(taken.updates.map((u) => u.task)).toEqual(Array.from({ length: 50 }, (_, i) => `t${i + 3}`));
    expect(updates.take(MAIN)).toEqual({ updates: [], dropped: 0 });
  });
});

describe("the prompt the daemon types for what waits", () => {
  test("names the tool of everything that waits, in one line, and nothing when nothing waits", () => {
    expect(inboxPrompt({ reviewComments: 0, messages: 0, updates: 0, miseTrusted: false })).toBeUndefined();
    expect(inboxPrompt({ reviewComments: 2, messages: 0, updates: 0, miseTrusted: false })).toBe(
      "The user sent a review of your changes in Trackwall: call get_review_comments (the trackwall MCP server) and address every comment.",
    );
    expect(inboxPrompt({ reviewComments: 0, messages: 1, updates: 3, miseTrusted: false })).toBe(
      "The session that proposed your task sent you a message in Trackwall: call get_messages (the trackwall MCP server) and follow it as an update of your task. " +
        "There is news about the work you delegated in Trackwall: call get_updates (the trackwall MCP server) and act on it.",
    );
  });

  test("says that the user trusted the mise config that refused the agent's run, which needs no tool to read", () => {
    expect(inboxPrompt({ reviewComments: 0, messages: 0, updates: 0, miseTrusted: true })).toBe(
      "The user trusted the mise config that refused your last run_mise_task, verify_task or start_service in Trackwall: run it again if you still need it.",
    );
  });
});

/** Moves the clock on, so what happens next is later than what happened before, also within one millisecond. */
function tenMillisecondsLater(): void {
  setSystemTime(new Date(Date.now() + 10));
}

function verification(taskId: string): Verification {
  return {
    task: taskId,
    repo: "shop",
    miseTask: "test",
    state: "passed",
    runId: "run-1",
    startedAt: "2026-10-25T12:00:00.000Z",
    finishedAt: "2026-10-25T12:01:00.000Z",
    exitCode: 1,
    message: null,
    tests: null,
    failures: [],
    errors: [],
    lastLines: [],
  };
}
