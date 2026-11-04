import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ConversationServerMessage, RunState } from "@trackwall/protocol";
import { AcpSession } from "../src/modules/agents/acp-session.ts";
import type { CopilotHookRecord } from "../src/modules/agents/copilot-hook-record.ts";
import { CopilotUsageLog } from "../src/modules/agents/copilot-usage-log.ts";
import type { SessionEvent } from "../src/modules/agents/live-session.ts";
import { STUCK_AFTER_MS } from "../src/modules/agents/session-stuck.ts";
import { NO_COPILOT_HOME } from "./support/live-session.ts";

const RUNNING: RunState = { runId: "r1", startedAt: "2026-10-28T08:00:00.000Z", kind: "running", pid: 1 };

/** A session on an agent this test plays by hand: what the session wrote, and lines the agent sends back. */
function session(
  o: { prompt?: () => string | undefined; situation?: () => string | undefined; firstMessage?: string; load?: string } = {},
) {
  const written: { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown }[] = [];
  const events: SessionEvent[] = [];
  const turnsOver = { count: 0 };
  let run: RunState = RUNNING;
  const acp = new AcpSession({
    id: "s1",
    repo: null,
    supervisor: true,
    task: null,
    cwd: "/projects",
    load: o.load,
    firstMessage: o.firstMessage,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    run: () => run,
    prompt: o.prompt ?? (() => undefined),
    situation: o.situation ?? (() => undefined),
    onUserText: () => {},
    onPromptSent: () => {},
    onEvent: (event) => events.push(event),
    onTurnOver: () => turnsOver.count++,
    onTurnStart: () => {},
    usage: new CopilotUsageLog(NO_COPILOT_HOME),
    log: () => {},
  });
  acp.connect({ write: (line) => written.push(JSON.parse(line)) });
  const send = (message: object) => acp.output(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
  const answer = (method: string, result: unknown) => {
    const request = written.findLast((m) => m.method === method);
    if (request?.id === undefined) throw new Error(`the session sent no ${method}`);
    send({ id: request.id, result });
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const ready = async () => {
    const started = acp.start();
    answer("initialize", { protocolVersion: 1 });
    await settle();
    answer("session/new", { sessionId: "c1" });
    await started;
  };
  return { acp, written, events, turnsOver, send, answer, settle, ready, exit: (r: RunState) => (run = r) };
}

const EXITED: RunState = {
  runId: "r1",
  startedAt: RUNNING.startedAt,
  kind: "exited",
  endedAt: "2026-10-28T08:01:00.000Z",
  exitCode: 1,
  signal: null,
  stoppedByUser: false,
  lastLines: [],
};

/** An approval request of conversation `c1` for tool `call`. */
function permission(id: number, call: string) {
  return {
    id,
    method: "session/request_permission",
    params: {
      sessionId: "c1",
      toolCall: { toolCallId: call, title: call },
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject_once", kind: "reject_once", name: "Deny" },
      ],
    },
  };
}

describe("a Copilot CLI session over ACP", () => {
  test("after the handshake the session waits for the user, and a message is a prompt that is Working until its answer", async () => {
    const s = session();
    await s.ready();
    expect(s.acp.view()?.state).toMatchObject({ state: "Input", source: "acp", confidence: "exact" });

    s.acp.say("Check the build");
    expect(s.written.at(-1)).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "c1", prompt: [{ type: "text", text: "Check the build" }] },
    });
    expect(s.acp.view()?.state?.state).toBe("Working");
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();

    expect(s.acp.view()?.state).toMatchObject({ state: "Input", reason: "stop end_turn" });
    // A turn the user drove is not news for a proposer.
    expect(s.events).toEqual([]);
  });

  test("a prompt's hook gets the situation as it is then, while the prompt itself and the conversation keep only what was said (ADR-148)", async () => {
    let situation = '- task t1 "Add a signup test" in shop, started by the user: working';
    const s = session({ situation: () => situation });
    const promptHook: CopilotHookRecord = { event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] };
    await s.ready();

    s.acp.say("What is going on?");
    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ type: "text", text: "What is going on?" }] } });
    expect(s.acp.hookOutput(promptHook)).toEqual({ additionalContext: situation });
    situation = '- task t1 "Add a signup test" in shop, started by the user: waits for the user\'s approval';
    expect(s.acp.hookOutput(promptHook)).toEqual({ additionalContext: situation });
    expect(s.acp.hookOutput({ ...promptHook, event: "postToolUse" })).toEqual({});
    expect(s.acp.hookOutput(undefined)).toEqual({});

    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    expect(frames).toMatchObject([{ type: "entries", entries: [{ kind: "user", text: "What is going on?", attachments: [] }] }]);
  });

  test("the first message goes as soon as the session is ready, and the end of its turn is reported, as the user did not write it", async () => {
    const s = session({ firstMessage: "Start my day." });
    await s.ready();

    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "Start my day." }] } });
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();
    expect(s.events).toEqual([{ kind: "turn_ended" }]);
  });

  test("the daemon's prompt waits for the end of the turn, and the end of its own turn is reported", async () => {
    const s = session({ prompt: () => "Read your messages." });
    await s.ready();
    s.acp.say("first");

    expect(s.acp.askToRead()).toBe("queued");
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();
    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "Read your messages." }] } });
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();

    expect(s.events).toEqual([{ kind: "turn_ended" }]);
  });

  test("what waits unread is pending once asked for, sent as the next prompt, and else idle until Deliver now (ADR-159)", async () => {
    const s = session({ prompt: () => "Read your messages." });
    await s.ready();
    s.acp.tick();
    expect(s.acp.view()?.readRequest?.waitsFor).toBe("idle");

    s.acp.say("first");
    s.acp.deliverNow();
    expect(s.acp.view()?.readRequest?.waitsFor).toBe("pending");
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();

    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "Read your messages." }] } });
    expect(s.acp.view()?.readRequest).toEqual({ prompt: "Read your messages.", since: expect.any(String), waitsFor: "sent" });
    const prompts = s.written.filter((m) => m.method === "session/prompt").length;
    s.acp.deliverNow();
    expect(s.acp.view()?.readRequest?.waitsFor).toBe("sent");
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();
    expect(s.written.filter((m) => m.method === "session/prompt").length).toBe(prompts);
    expect(s.acp.view()?.readRequest?.waitsFor).toBe("idle");
  });

  test("an approval of a file edit names the file in the working directory and carries the change as a patch", async () => {
    const s = session();
    await s.ready();
    s.acp.say("go");
    const diff = "diff --git a/projects/a.ts b/projects/a.ts\n--- a/projects/a.ts\n+++ b/projects/a.ts\n@@ -1,1 +1,1 @@\n-one\n+ONE\n";
    s.send({
      id: 0,
      method: "session/request_permission",
      params: {
        sessionId: "c1",
        toolCall: {
          toolCallId: "call_1",
          title: "Edit file",
          kind: "edit",
          rawInput: { fileName: "/projects/a.ts", diff: `\n${diff}` },
          locations: [{ path: "/projects/a.ts" }],
        },
        options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }],
      },
    });

    expect(s.acp.view()?.dialog).toMatchObject({ kind: "approval", title: "Edit file", detail: ["a.ts"], patch: diff });
  });

  test("an approval request is the session's dialog until it is answered with the option's digit", async () => {
    const s = session();
    await s.ready();
    s.acp.say("go");
    s.send({
      id: 0,
      method: "session/request_permission",
      params: {
        sessionId: "c1",
        toolCall: { toolCallId: "call_1", title: "Say hi", kind: "execute", rawInput: { command: "echo hi" } },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject_once", kind: "reject_once", name: "Deny" },
        ],
      },
    });

    const view = s.acp.view();
    expect(view?.state?.state).toBe("Approval");
    expect(view?.dialog).toEqual({
      id: "approval-1",
      kind: "approval",
      title: "Say hi",
      detail: ["$ echo hi"],
      patch: "",
      patchCut: false,
      question: "Do you want to allow this?",
      options: [
        { key: "1", label: "Allow once" },
        { key: "2", label: "Deny" },
      ],
    });
    expect(() => s.acp.answerDialog("approval-0", "1")).toThrow("the approval was answered or it changed");
    s.acp.answerDialog("approval-1", "2");
    await s.settle();

    expect(s.written.at(-1)).toEqual({ jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "selected", optionId: "reject_once" } } });
    expect(s.acp.view()).toMatchObject({ dialog: null, state: { state: "Working" } });
  });

  test("Stop refuses the approval waiting and cancels the turn", async () => {
    const s = session();
    await s.ready();
    s.acp.say("go");
    s.send({
      id: 0,
      method: "session/request_permission",
      params: {
        sessionId: "c1",
        toolCall: { toolCallId: "call_1" },
        options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }],
      },
    });

    s.acp.answerDialog("approval-1", "stop");
    await s.settle();

    expect(s.written.slice(-2)).toEqual([
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "c1" } },
      { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } },
    ]);
  });

  test("updates of another conversation and kinds the daemon does not show change nothing, and other requests are refused", async () => {
    const s = session();
    await s.ready();
    const frames: unknown[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    s.send({
      method: "session/update",
      params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "no" } } },
    });
    s.send({ method: "session/update", params: { sessionId: "c1", update: { sessionUpdate: "plan", entries: [] } } });
    s.send({ id: 5, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
    await s.settle();

    expect(frames).toEqual([{ type: "entries", reset: true, entries: [], waiting: [], mode: null, context: null, commands: [] }]);
    expect(s.written.at(-1)).toMatchObject({ id: 5, error: { code: -32603 } });
  });

  test("when the process exits during an approval, the approval is refused and the session is Done", async () => {
    const s = session();
    await s.ready();
    s.acp.say("go");
    s.send({
      id: 0,
      method: "session/request_permission",
      params: {
        sessionId: "c1",
        toolCall: { toolCallId: "call_1" },
        options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }],
      },
    });

    s.exit({
      runId: "r1",
      startedAt: RUNNING.startedAt,
      kind: "exited",
      endedAt: "2026-10-28T08:01:00.000Z",
      exitCode: 0,
      signal: null,
      stoppedByUser: true,
      lastLines: [],
    });

    expect(s.acp.tick()).toBe(false);
    expect(s.acp.view()).toMatchObject({ dialog: null, state: { state: "Done", source: "exit" } });
    expect(s.events).toEqual([{ kind: "exited", exitCode: 0, stoppedByUser: true }]);
    expect(() => s.acp.say("more")).toThrow("the session has ended");
  });

  test("a process that ends during the handshake fails the start instead of leaving it waiting", async () => {
    const s = session();
    const started = s.acp.start();
    s.exit(EXITED);

    await expect(started).rejects.toThrow("the agent ended before it answered");
  });

  test("an agent of another ACP version, or one that cannot load, fails the start", async () => {
    const other = session();
    const started = other.acp.start();
    other.answer("initialize", { protocolVersion: 2 });
    await expect(started).rejects.toThrow("Copilot CLI speaks ACP version 2, not 1");

    const noLoad = session({ load: "c0" });
    const loading = noLoad.acp.start();
    noLoad.answer("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: false } });
    await expect(loading).rejects.toThrow("Copilot CLI cannot load a conversation over ACP");
  });

  test("a conversation Copilot CLI no longer keeps fails the start with its error", async () => {
    const s = session({ load: "c0" });
    const started = s.acp.start();
    s.answer("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    await s.settle();
    const load = s.written.findLast((m) => m.method === "session/load");
    s.send({ id: load?.id, error: { code: -32002, message: "Session c0 not found" } });

    await expect(started).rejects.toThrow("session/load: Session c0 not found (-32002)");
  });

  test("the day start's first message goes before what the user wrote while the session started", async () => {
    const s = session({ firstMessage: "Start my day." });
    const started = s.acp.start();
    s.acp.say("and check the build");
    s.answer("initialize", { protocolVersion: 1 });
    await s.settle();
    s.answer("session/new", { sessionId: "c1" });
    await started;

    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "Start my day." }] } });
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();
    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "and check the build" }] } });
  });

  test("approvals of tools called at once wait one after another, the first as the dialog", async () => {
    const s = session();
    await s.ready();
    s.acp.say("go");
    s.send(permission(0, "first"));
    s.send(permission(1, "second"));

    expect(s.acp.view()?.dialog).toMatchObject({ id: "approval-1", title: "first" });
    s.acp.answerDialog("approval-1", "1");
    await s.settle();
    expect(s.acp.view()).toMatchObject({ dialog: { id: "approval-2", title: "second" }, state: { state: "Approval" } });
    s.acp.answerDialog("approval-2", "2");
    await s.settle();

    expect(s.written.slice(-2)).toEqual([
      { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "selected", optionId: "allow_once" } } },
      { jsonrpc: "2.0", id: 1, result: { outcome: { outcome: "selected", optionId: "reject_once" } } },
    ]);
    expect(s.acp.view()).toMatchObject({ dialog: null, state: { state: "Working" } });
  });

  test("an approval asked after Stop, or outside a turn, is refused at once, and none outlives its turn", async () => {
    const s = session();
    await s.ready();
    s.send(permission(0, "outside"));
    s.acp.say("go");
    s.acp.interrupt();
    s.send(permission(1, "late"));
    s.answer("session/prompt", { stopReason: "cancelled" });
    s.acp.say("again");
    s.send(permission(2, "kept"));
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();

    const answers = s.written.filter((m) => m.id !== undefined && m.method === undefined);
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: 1, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: 2, result: { outcome: { outcome: "cancelled" } } },
    ]);
    expect(s.acp.view()?.dialog).toBeNull();
  });

  test("after a failed turn the message the user wrote meanwhile still goes", async () => {
    const s = session();
    await s.ready();
    s.acp.say("first");
    s.acp.say("second");
    const prompt = s.written.findLast((m) => m.method === "session/prompt");
    s.send({ id: prompt?.id, error: { code: -32603, message: "the model is overloaded" } });
    await s.settle();

    expect(s.events).toEqual([{ kind: "error" }]);
    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "second" }] } });
  });

  test("every turn that is over counts, also one the user started and one that failed, since the agent may have committed in it", async () => {
    const s = session();
    await s.ready();
    s.acp.say("first");
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();
    s.acp.say("second");
    const prompt = s.written.findLast((m) => m.method === "session/prompt");
    s.send({ id: prompt?.id, error: { code: -32603, message: "the model is overloaded" } });
    await s.settle();

    expect(s.turnsOver.count).toBe(2);
  });

  test("a message written during a turn reaches the views at once as waiting, and becomes the user's entry when the turn ends and it goes", async () => {
    const s = session();
    await s.ready();
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    s.acp.say("Check the build");
    s.acp.say("and the tests");
    await new Promise((r) => setTimeout(r, 100));

    expect(frames.flatMap((f) => f.entries)).toEqual([{ id: "user-1", kind: "user", text: "Check the build", attachments: [] }]);
    expect(frames.at(-1)?.waiting).toEqual([{ id: "waiting-2", text: "and the tests", attachments: [] }]);
    const later: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => later.push(m), closed: () => {} });
    expect(later[0]?.waiting).toEqual([{ id: "waiting-2", text: "and the tests", attachments: [] }]);

    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "and the tests" }] } });
    expect(frames.at(-1)).toMatchObject({ entries: [{ kind: "user", text: "and the tests", attachments: [] }], waiting: [] });
  });

  test("a message the agent gets at once sends the views one frame, with nothing waiting", async () => {
    const s = session();
    await s.ready();
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    s.acp.say("Check the build");
    await new Promise((r) => setTimeout(r, 100));

    expect(frames.slice(1)).toEqual([
      { type: "entries", reset: false, entries: [{ id: "user-1", kind: "user", text: "Check the build", attachments: [] }], waiting: [] },
    ]);
  });

  test("chunks of a streamed answer reach the views as one frame", async () => {
    const s = session();
    await s.ready();
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    for (const piece of ["All ", "tests ", "pass."])
      s.send({
        method: "session/update",
        params: { sessionId: "c1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } } },
      });
    await new Promise((r) => setTimeout(r, 100));

    expect(frames).toEqual([
      { type: "entries", reset: true, entries: [], waiting: [], mode: null, context: null, commands: [] },
      { type: "entries", reset: false, entries: [{ id: "agent-1", kind: "agent", text: "All tests pass." }], waiting: [] },
    ]);
  });

  test("the views get the end of the answer before the session says the turn has ended", async () => {
    const s = session();
    await s.ready();
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    s.acp.say("Check the build");
    s.send({
      method: "session/update",
      params: { sessionId: "c1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } },
    });
    s.answer("session/prompt", { stopReason: "end_turn" });
    await s.settle();

    expect(s.acp.view()?.state?.state).toBe("Input");
    expect(frames.at(-1)?.entries.at(-1)).toEqual({ id: "agent-2", kind: "agent", text: "Done." });
  });
});

describe("a session over ACP that may be stuck (ADR-151)", () => {
  afterEach(() => setSystemTime());

  test("is one whose prompt has had no update for 15 minutes, until the agent's next update", async () => {
    const start = Date.parse("2026-10-31T09:00:00.000Z");
    const s = session();
    await s.ready();
    setSystemTime(new Date(start));
    s.acp.say("Run the service");

    setSystemTime(new Date(start + STUCK_AFTER_MS));
    expect(s.acp.view()).toMatchObject({ state: { state: "Working" }, stuck: { lastStepAt: "2026-10-31T09:00:00.000Z" } });

    s.send({
      method: "session/update",
      params: { sessionId: "c1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Still starting" } } },
    });
    expect(s.acp.view()?.stuck).toBeNull();
  });
});

describe("the agent's mode, context use and commands in the conversation view", () => {
  const AGENT = "https://agentclientprotocol.com/protocol/session-modes#agent";
  const PLAN = "https://agentclientprotocol.com/protocol/session-modes#plan";
  const modes = (current: string) => [
    {
      id: "mode",
      currentValue: current,
      options: [
        { value: AGENT, name: "Agent", description: "Default agent mode" },
        { value: PLAN, name: "Plan", description: "Plan mode" },
      ],
    },
  ];

  test("commands sent before session/new answers, the mode it answers with and a usage update reach the views", async () => {
    const s = session();
    const started = s.acp.start();
    s.answer("initialize", { protocolVersion: 1 });
    await s.settle();
    s.send({
      method: "session/update",
      params: {
        sessionId: "c1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "compact", description: "Summarize", input: { hint: "focus" } }],
        },
      },
    });
    s.answer("session/new", { sessionId: "c1", configOptions: modes(AGENT) });
    await started;
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    s.send({
      method: "session/update",
      params: { sessionId: "c1", update: { sessionUpdate: "usage_update", used: 10_777, size: 128_000 } },
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(frames).toEqual([
      {
        type: "entries",
        reset: true,
        entries: [],
        waiting: [],
        mode: {
          current: AGENT,
          options: [
            { id: AGENT, name: "Agent", description: "Default agent mode" },
            { id: PLAN, name: "Plan", description: "Plan mode" },
          ],
        },
        context: null,
        commands: [{ name: "compact", description: "Summarize", hint: "focus" }],
      },
      { type: "entries", reset: false, entries: [], waiting: [], context: { used: 10_777, size: 128_000 } },
    ]);
  });

  test("settings the daemon cannot read leave the mode unknown and the session starts", async () => {
    const s = session();
    const started = s.acp.start();
    s.answer("initialize", { protocolVersion: 1 });
    await s.settle();
    const settings = Array.from({ length: 51 }, (_, i) => ({ id: `setting-${i}`, currentValue: "off" }));
    s.answer("session/new", { sessionId: "c1", configOptions: [...settings, { currentValue: "no id" }] });
    await started;
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });

    expect(s.acp.view()?.state?.state).toBe("Input");
    expect(frames[0]?.mode).toBeNull();
  });

  test("an update of another conversation sent before session/new answers never reaches the views", async () => {
    const s = session();
    const started = s.acp.start();
    s.answer("initialize", { protocolVersion: 1 });
    await s.settle();
    s.send({
      method: "session/update",
      params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not ours" } } },
    });
    s.answer("session/new", { sessionId: "c1" });
    await started;
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    await new Promise((r) => setTimeout(r, 100));

    expect(frames.flatMap((f) => f.entries)).toEqual([]);
  });

  test("switching the mode asks the agent, and a mode it does not offer is refused without asking", async () => {
    const s = session();
    const started = s.acp.start();
    s.answer("initialize", { protocolVersion: 1 });
    await s.settle();
    s.answer("session/new", { sessionId: "c1", configOptions: modes(AGENT) });
    await started;

    const switched = s.acp.setMode(PLAN);
    await s.settle();
    expect(s.written.at(-1)).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "c1", configId: "mode", value: PLAN },
    });
    s.answer("session/set_config_option", { configOptions: modes(PLAN) });
    await switched;
    const frames: ConversationServerMessage[] = [];
    s.acp.attachConversation({ send: (m) => frames.push(m), closed: () => {} });
    expect(frames[0]?.mode?.current).toBe(PLAN);

    const asked = s.written.length;
    await expect(s.acp.setMode("https://agentclientprotocol.com/protocol/session-modes#autopilot")).rejects.toThrow(
      "the agent does not offer this mode",
    );
    expect(s.written).toHaveLength(asked);
  });
});
