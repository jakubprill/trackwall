import { describe, expect, test } from "bun:test";
import type { ConversationServerMessage, RunState } from "@trackwall/protocol";
import { AcpSession } from "../src/modules/agents/acp-session.ts";
import type { SessionEvent } from "../src/modules/agents/live-session.ts";

const RUNNING: RunState = { runId: "r1", startedAt: "2026-10-28T08:00:00.000Z", kind: "running", pid: 1 };

/** A session on an agent this test plays by hand: what the session wrote, and lines the agent sends back. */
function session(o: { prompt?: () => string | undefined; firstMessage?: string; load?: string } = {}) {
  const written: { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown }[] = [];
  const events: SessionEvent[] = [];
  let run: RunState = RUNNING;
  const acp = new AcpSession({
    id: "s1",
    repo: null,
    supervisor: true,
    task: null,
    cwd: "/projects",
    load: o.load,
    firstMessage: o.firstMessage,
    environment: { variables: [], secrets: [], agentSecrets: [], problem: null },
    run: () => run,
    prompt: o.prompt ?? (() => undefined),
    onUserText: () => {},
    onPromptSent: () => {},
    onEvent: (event) => events.push(event),
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
  return { acp, written, events, send, answer, settle, ready, exit: (r: RunState) => (run = r) };
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
    s.send({ method: "session/update", params: { sessionId: "c1", update: { sessionUpdate: "usage_update", used: 1, size: 2 } } });
    s.send({ id: 5, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
    await s.settle();

    expect(frames).toEqual([{ type: "entries", reset: true, entries: [] }]);
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
      { type: "entries", reset: true, entries: [] },
      { type: "entries", reset: false, entries: [{ id: "agent-1", kind: "agent", text: "All tests pass." }] },
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
