import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState } from "@trackwall/protocol";
import type { CopilotHookEvent, CopilotHookRecord } from "../src/modules/agents/copilot-hook-record.ts";
import { LiveSession, type SessionEvent } from "../src/modules/agents/live-session.ts";
import { screenProcessed } from "./support/live-session.ts";

const sessions: LiveSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

describe("a Copilot CLI session in the daemon", () => {
  test("a key counts from the state after the hooks already in hooks.jsonl, although the read cycle has not read them yet", () => {
    const hooksFile = join(mkdtempSync(join(tmpdir(), "trackwall-session-")), "hooks.jsonl");
    writeFileSync(hooksFile, "");
    const written: string[] = [];
    const session = new LiveSession({
      id: "s1",
      repo: "shop",
      supervisor: false,
      task: null,
      cols: 80,
      rows: 24,
      hooksFile,
      promptOnStart: false,
      hasConversation: false,
      program: "copilot",
      environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
      run: () => ({ kind: "running", runId: "r1", startedAt: "2026-10-24T12:00:00.000Z", pid: 1 }),
      prompt: () => undefined,
      situation: () => undefined,
      onPromptSent: () => {},
      onUserText: () => {},
      onEvent: () => {},
      onTurnOver: () => {},
    });
    sessions.push(session);
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "permission_prompt" }, omitted: [] })}\n`,
    );

    session.input("\r");

    expect(written).toEqual(["\r"]);
    expect(session.view()?.state).toMatchObject({ state: "Working", source: "keyboard", reason: "key enter" });
  });

  test("the end of a turn waits for you until a session terminal comes in front of the user", () => {
    const { session, hooksFile } = runningSession();
    const window = session.attach(
      () => {},
      () => {},
      () => {},
    );
    endTurn(session, hooksFile);
    expect(session.view()).toMatchObject({ state: { state: "Input", reason: "hook agentStop" }, needsAttention: true });

    window.focus(true);

    expect(session.view()).toMatchObject({ state: { state: "Input" }, needsAttention: false });
    window.detach();
  });

  test("a closed window no longer watches the session, so the next end of a turn waits for you", () => {
    const { session, hooksFile } = runningSession();
    const window = session.attach(
      () => {},
      () => {},
      () => {},
    );
    window.focus(true);
    endTurn(session, hooksFile);
    expect(session.view()?.needsAttention).toBe(false);

    window.detach();
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    endTurn(session, hooksFile);

    expect(session.view()).toMatchObject({ state: { state: "Input" }, needsAttention: true });
  });

  test("Esc that interrupts the turn leaves the session idle, not waiting for you", () => {
    const { session, hooksFile } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();

    session.input("\u001b");

    expect(session.view()).toMatchObject({ state: { state: "Input", reason: "key escape" }, needsAttention: false });
  });

  test("an answer xterm.js sends to a terminal query does not mark the session seen", () => {
    const { session, hooksFile } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    endTurn(session, hooksFile);

    session.input("\u001b]11;rgb:0000/0000/0000\u001b\\");

    expect(session.view()?.needsAttention).toBe(true);
  });

  test("typing into the session marks the end of the turn seen", () => {
    const { session, hooksFile } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    endTurn(session, hooksFile);

    session.input("n");

    expect(session.view()).toMatchObject({ state: { state: "Input" }, needsAttention: false });
  });
});

/**
 * A running session with an empty `hooks.jsonl`; the hook records are the input of each test. `prompt` is what waits
 * for it (its daemon prompt), `typedText` counts how often the user put text into it, and `events` collects what its
 * agent did. `run` is the state of its process group.
 */
function runningSession(
  prompt: () => string | undefined = () => "read the review",
  run: () => RunState = () => ({ kind: "running", runId: "r2", startedAt: "2026-10-24T12:00:00.000Z", pid: 1 }),
  situation: () => string | undefined = () => undefined,
): {
  session: LiveSession;
  hooksFile: string;
  typedText: { count: number };
  promptsSent: { count: number };
  events: SessionEvent[];
} {
  const typedText = { count: 0 };
  const promptsSent = { count: 0 };
  const events: SessionEvent[] = [];
  const hooksFile = join(mkdtempSync(join(tmpdir(), "trackwall-session-")), "hooks.jsonl");
  writeFileSync(hooksFile, "");
  const session = new LiveSession({
    id: "s2",
    repo: "shop",
    supervisor: false,
    task: null,
    cols: 80,
    rows: 24,
    hooksFile,
    promptOnStart: false,
    hasConversation: false,
    program: "copilot",
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    run,
    prompt,
    situation,
    onPromptSent: () => {
      promptsSent.count++;
    },
    onUserText: () => {
      typedText.count++;
    },
    onEvent: (event) => events.push(event),
    onTurnOver: () => {},
  });
  sessions.push(session);
  return { session, hooksFile, typedText, promptsSent, events };
}

/** The bottom of an idle Copilot CLI: the input box and the footer with hints (ADR-69). */
const PROMPT_BOX = "────\r\n❯ \r\n────\r\n Interactive · / commands\r\n";

function endTurn(session: LiveSession, hooksFile: string): void {
  appendFileSync(hooksFile, `${JSON.stringify({ event: "agentStop", receivedAt: 0, payload: {}, omitted: [] })}\n`);
  session.tick();
}

/** The end of a turn as Copilot CLI shows it: `agentStop`, then the input box drawn again. */
async function endTurnAtBox(session: LiveSession, hooksFile: string): Promise<void> {
  endTurn(session, hooksFile);
  await showScreen(session, PROMPT_BOX);
}

/** Copilot CLI draws `text` on the session's screen, and the daemon's next read cycle sees it. */
async function showScreen(session: LiveSession, text: string): Promise<void> {
  session.output(new TextEncoder().encode(text));
  await screenProcessed(session);
  session.tick();
}

/** Runs `step` with the clock `ms` later. */
function later<T>(ms: number, step: () => T): T {
  setSystemTime(new Date(Date.now() + ms));
  try {
    return step();
  } finally {
    setSystemTime();
  }
}

describe("a prompt the daemon types into a session (a review, ADR-62, or a message or update, ADR-68)", () => {
  test("goes in only once the session waits for input, with Enter written separately after the text", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);

    expect(session.askToRead()).toBe("queued");
    expect(written).toEqual([]);

    await endTurnAtBox(session, hooksFile);
    expect(written).toEqual(["read the review"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(written).toEqual(["read the review", "\r"]);
  });

  test("goes into a new session's input box on the screen before its first hook, and that hook then starts work", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    session.output(new TextEncoder().encode(`Welcome\r\n${PROMPT_BOX}`));
    await screenProcessed(session);

    expect(session.askToRead()).toBe("typed");
    expect(written).toEqual(["read the review"]);
    // Not waiting for you while the agent is about to read the review.
    expect(session.view()).toMatchObject({ state: null, needsAttention: false });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "sessionStart", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    expect(session.view()?.state).toMatchObject({ state: "Working", reason: "hook sessionStart with a prompt" });
  });

  test("a prompt a new session does not take holds back its waiting for you only while the daemon tries again, 5 s each", async () => {
    const { session } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    session.output(new TextEncoder().encode(PROMPT_BOX));
    await screenProcessed(session);
    expect(session.askToRead()).toBe("typed");
    session.tick();
    expect(session.view()?.state).toBeNull();

    later(6000, () => session.tick());
    later(12_000, () => session.tick());
    expect(session.view()?.state).toBeNull();
    later(18_000, () => session.tick());

    expect(written.filter((data) => data !== "\r")).toEqual(["read the review", "read the review", "read the review"]);
    expect(later(24_000, () => session.view()?.state)).toMatchObject({ state: "Input", source: "screen" });
  });

  test("waits in a new session whose screen does not show the input box yet", async () => {
    const { session } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    session.output(new TextEncoder().encode("────\r\n❯ \r\n────\r\n ◎ Loading: 1 plugin\r\n"));
    await screenProcessed(session);

    expect(session.askToRead()).toBe("queued");
    expect(written).toEqual([]);
    expect(session.view()?.state).toBeNull();
  });

  test("in a session whose hooks never come, goes in only while the screen shows the input box now, not into a later approval", async () => {
    const { session } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    session.output(new TextEncoder().encode(PROMPT_BOX));
    await screenProcessed(session);
    session.tick();
    expect(session.view()?.state).toMatchObject({ state: "Input", source: "screen" });

    session.output(new TextEncoder().encode("╭────╮\r\n│ Do you want to run this command? │\r\n│ ❯ 1. Yes │\r\n╰────╯\r\n"));
    await screenProcessed(session);

    expect(session.askToRead()).toBe("queued");
    expect(written).toEqual([]);
  });

  test("goes in at once while the session waits for input, and does not mark the end of the turn seen", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);

    expect(session.askToRead()).toBe("typed");

    expect(written).toEqual(["read the review"]);
    expect(session.view()?.needsAttention).toBe(true);
  });

  test("is typed once: a second prompt before Copilot CLI takes the first changes nothing", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);

    expect(session.askToRead()).toBe("typed");
    expect(session.askToRead()).toBe("typed");

    expect(written).toEqual(["read the review"]);
  });

  test("waits after an Esc and for a question dialog, which leave the session in Input but not in its input box", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    session.input("\u001b");
    expect(session.askToRead()).toBe("queued");
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "elicitation_dialog" }, omitted: [] })}\n`,
    );
    session.tick();
    expect(written).toEqual(["\u001b"]);

    await endTurnAtBox(session, hooksFile);

    expect(written).toEqual(["\u001b", "read the review"]);
  });

  test("waits for a question dialog right after the start, which the state alone does not show", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    for (const record of [
      { event: "sessionStart", receivedAt: 0, payload: { source: "resume" }, omitted: [] },
      { event: "notification", receivedAt: 0, payload: { notification_type: "elicitation_dialog" }, omitted: [] },
    ])
      appendFileSync(hooksFile, `${JSON.stringify(record)}\n`);

    expect(session.askToRead()).toBe("queued");
    expect(written).toEqual([]);
  });

  test("waits while the user is typing a message of their own", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    session.input("also check the");

    expect(session.askToRead()).toBe("queued");
    expect(written).toEqual(["also check the"]);
  });

  test("waits after agentStop until Copilot CLI draws the input box again, since text typed in between is lost", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    expect(session.askToRead()).toBe("queued");

    endTurn(session, hooksFile);
    expect(written).toEqual([]);

    await showScreen(session, PROMPT_BOX);
    expect(written).toEqual(["read the review"]);
  });

  test("is typed again when it was lost and the input box is still empty after 5 s", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    expect(session.askToRead()).toBe("typed");
    expect(session.askToRead()).toBe("typed");

    later(6000, () => session.tick());

    expect(written).toEqual(["read the review", "read the review"]);
  });

  test("gets Enter again when it still sits in the input box after 5 s, at most twice", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    expect(session.askToRead()).toBe("typed");
    await showScreen(session, "────\r\n❯ read the review\r\n────\r\n Interactive · / commands\r\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(written).toEqual(["read the review", "\r"]);

    later(6000, () => session.tick());
    later(12_000, () => session.tick());
    later(18_000, () => session.tick());

    expect(written).toEqual(["read the review", "\r", "\r", "\r"]);
  });

  test("leaves text in the input box that is not its prompt alone, and goes in once the box is empty", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    expect(session.askToRead()).toBe("typed");
    await new Promise((r) => setTimeout(r, 200));
    await showScreen(session, "────\r\n❯ an older message\r\n────\r\n Interactive · / commands\r\n");

    later(6000, () => session.tick());
    expect(written).toEqual(["read the review", "\r"]);
    await showScreen(session, PROMPT_BOX);

    expect(written).toEqual(["read the review", "\r", "read the review"]);
  });

  test("a prompt that shows up in the input box only after a busy screen still gets its Enter", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    session.askToRead();
    await new Promise((r) => setTimeout(r, 200));
    await showScreen(session, "────\r\n❯ \r\n────\r\n ◉ Working · read the review\r\n");
    later(30_000, () => session.tick());
    expect(written).toEqual(["read the review", "\r"]);

    await showScreen(session, "────\r\n❯ read the review\r\n────\r\n Interactive · / commands\r\n");
    later(31_000, () => session.tick());

    expect(written).toEqual(["read the review", "\r", "\r"]);
  });

  test("waits while Copilot CLI shows no input box", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    session.askToRead();
    await showScreen(session, "────\r\n❯ \r\n────\r\n ◉ Working · read the review\r\n");

    later(6000, () => session.tick());

    expect(written).toEqual(["read the review"]);
  });

  test("a draft the user cleared without sending holds the prompt back only until the input box stays empty for 2 s", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    session.input("also check the");
    session.input("\u0003");
    expect(session.askToRead()).toBe("queued");
    session.tick();
    expect(written).toEqual(["also check the", "\u0003"]);

    later(3000, () => session.tick());

    expect(written).toEqual(["also check the", "\u0003", "read the review"]);
  });

  test("a draft counts as gone only after the input box stayed empty for 2 s without a break", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    session.input("x");
    session.askToRead();
    await showScreen(session, "────\r\n❯ x\r\n────\r\n Interactive · / commands\r\n");
    later(3000, () => session.tick());
    await showScreen(session, PROMPT_BOX);
    expect(written).toEqual(["x"]);

    later(6000, () => session.tick());

    expect(written).toEqual(["x", "read the review"]);
  });

  test("text the user is still typing holds the prompt back however long it stays in the input box", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    session.input("also check the");
    await showScreen(session, "────\r\n❯ also check the\r\n────\r\n Interactive · / commands\r\n");
    expect(session.askToRead()).toBe("queued");

    later(10_000, () => session.tick());

    expect(written).toEqual(["also check the"]);
  });

  test("a background shell finishing does not take the session out of its input box", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "shell_completed" }, omitted: [] })}\n`,
    );

    expect(session.askToRead()).toBe("typed");
    expect(written).toEqual(["read the review"]);
  });

  test("waits for text the user typed during the turn and has not sent, and for a turn that started again in the same read", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    session.input("next, rename foo");
    session.askToRead();
    await endTurnAtBox(session, hooksFile);
    expect(written).toEqual(["next, rename foo"]);

    for (const event of ["userPromptSubmitted", "agentStop", "userPromptSubmitted"])
      appendFileSync(hooksFile, `${JSON.stringify({ event, receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();

    expect(written).toEqual(["next, rename foo"]);
  });

  test("a request the typed prompt does not cover goes in after the turn that prompt starts, with the prompt read then", async () => {
    let waiting = "read the review";
    const { session, hooksFile } = runningSession(() => waiting);
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    expect(session.askToRead()).toBe("typed");

    waiting = "read the review and the message";
    expect(session.askToRead()).toBe("queued");
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    waiting = "read the message";
    await endTurnAtBox(session, hooksFile);

    expect(written).toEqual(["read the review", "read the message"]);
  });

  test("types nothing when everything was read before the session got back to its input box", async () => {
    let waiting: string | undefined = "read the message";
    const { session, hooksFile } = runningSession(() => waiting);
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    expect(session.askToRead()).toBe("queued");

    waiting = undefined;
    await endTurnAtBox(session, hooksFile);
    waiting = "read the message";
    session.tick();

    expect(written).toEqual([]);
  });
});

/** Appends a hook record, as the daemon does when the hook's POST comes, and returns the session's output for it. */
function hook(session: LiveSession, hooksFile: string, event: CopilotHookEvent, payload: CopilotHookRecord["payload"] = {}) {
  const record: CopilotHookRecord = { event, receivedAt: 0, payload, omitted: [] };
  appendFileSync(hooksFile, `${JSON.stringify(record)}\n`);
  return session.hookOutput(record);
}

describe("what waits for a session, given to its agent through the hooks' output (ADR-85)", () => {
  /** A session in the middle of a turn with `prompt` asked for, and what the daemon types into it. */
  function workingSession(prompt: () => string | undefined = () => "read the review") {
    const running = runningSession(prompt);
    const written: string[] = [];
    running.session.connect({ write: (data) => written.push(data), resize: () => {} });
    hook(running.session, running.hooksFile, "userPromptSubmitted");
    return { ...running, written };
  }

  test("the end of a turn is blocked with the prompt, which starts the next turn without typing or a turn_ended", async () => {
    const { session, hooksFile, events, written } = workingSession();
    expect(session.askToRead()).toBe("queued");

    expect(hook(session, hooksFile, "agentStop", { stopReason: "end_turn", stop_hook_active: false })).toEqual({
      decision: "block",
      reason: "read the review",
    });
    await showScreen(session, PROMPT_BOX);
    hook(session, hooksFile, "userPromptSubmitted");
    session.tick();

    expect(written).toEqual([]);
    expect(events).toEqual([]);
    expect(session.view()?.state).toMatchObject({ state: "Working" });
  });

  test("a block Copilot CLI did not act on is typed once the input box is back after 5 s", async () => {
    const { session, hooksFile, written } = workingSession();
    session.askToRead();
    expect(hook(session, hooksFile, "agentStop")).toEqual({ decision: "block", reason: "read the review" });
    await showScreen(session, PROMPT_BOX);
    expect(written).toEqual([]);

    later(6000, () => session.tick());

    expect(written).toEqual(["read the review"]);
  });

  test("a turn a block started that ends with the prompt unread is not blocked again: the prompt is typed into the box", async () => {
    const { session, hooksFile, events, written } = workingSession();
    session.askToRead();
    hook(session, hooksFile, "agentStop");
    hook(session, hooksFile, "userPromptSubmitted");

    expect(hook(session, hooksFile, "agentStop", { stop_hook_active: true })).toEqual({});
    expect(written).toEqual([]);
    await showScreen(session, PROMPT_BOX);
    session.tick();

    expect(written).toEqual(["read the review"]);
    expect(events).toEqual([{ kind: "turn_ended" }]);
  });

  test("a turn a block started that read the prompt ends with a turn_ended and types nothing", async () => {
    let waiting: string | undefined = "read the review";
    const { session, hooksFile, events, written } = workingSession(() => waiting);
    session.askToRead();
    hook(session, hooksFile, "agentStop");
    hook(session, hooksFile, "userPromptSubmitted");
    waiting = undefined;

    expect(hook(session, hooksFile, "agentStop", { stop_hook_active: true })).toEqual({});
    await showScreen(session, PROMPT_BOX);
    later(6000, () => session.tick());

    expect(written).toEqual([]);
    expect(events).toEqual([{ kind: "turn_ended" }]);
  });

  test("the prompt counts as sent when it blocks the end of a turn or is typed, not when it goes with a tool's result", async () => {
    const { session, hooksFile, promptsSent, written } = workingSession();
    session.askToRead();

    hook(session, hooksFile, "postToolUse");
    expect(promptsSent.count).toBe(0);
    hook(session, hooksFile, "agentStop");
    expect(promptsSent.count).toBe(1);
    hook(session, hooksFile, "userPromptSubmitted");
    hook(session, hooksFile, "agentStop", { stop_hook_active: true });
    expect(promptsSent.count).toBe(1);
    await showScreen(session, PROMPT_BOX);
    session.tick();

    expect(written).toEqual(["read the review"]);
    expect(promptsSent.count).toBe(2);
  });

  test("a tool's result carries the prompt once per turn, and again for a prompt that changed or in the next turn", () => {
    let waiting = "read the review";
    const { session, hooksFile } = workingSession(() => waiting);
    session.askToRead();

    expect(hook(session, hooksFile, "postToolUse")).toEqual({ additionalContext: "read the review" });
    expect(hook(session, hooksFile, "postToolUse")).toEqual({});
    waiting = "read the review and the message";
    expect(hook(session, hooksFile, "postToolUse")).toEqual({ additionalContext: "read the review and the message" });
    hook(session, hooksFile, "userPromptSubmitted");
    expect(hook(session, hooksFile, "postToolUse")).toEqual({ additionalContext: "read the review and the message" });
  });

  test("nothing asked for, nothing unread any more, or the user's unsent text in the input box gives the empty output", () => {
    let waiting: string | undefined = "read the updates";
    const { session, hooksFile } = workingSession(() => waiting);
    expect(hook(session, hooksFile, "postToolUse")).toEqual({});
    expect(hook(session, hooksFile, "agentStop")).toEqual({});
    hook(session, hooksFile, "userPromptSubmitted");

    session.askToRead();
    waiting = undefined;
    expect(hook(session, hooksFile, "postToolUse")).toEqual({});

    waiting = "read the review";
    session.input("also check the");
    expect(hook(session, hooksFile, "agentStop")).toEqual({});
  });

  test("a hook whose payload left no record gets the empty output", () => {
    const { session } = workingSession();
    session.askToRead();

    expect(session.hookOutput(undefined)).toEqual({});
  });
});

describe("the supervisor's situation with every prompt (ADR-148)", () => {
  test("every prompt the agent gets, the user's or the daemon's block, comes with the situation as it is then; no other hook does", () => {
    let situation = '- task t1 "Add a signup test" in shop, started by the user: working';
    const { session, hooksFile } = runningSession(
      () => "read the updates",
      undefined,
      () => situation,
    );

    expect(hook(session, hooksFile, "userPromptSubmitted")).toEqual({ additionalContext: situation });
    expect(hook(session, hooksFile, "postToolUse")).toEqual({});
    session.askToRead();
    expect(hook(session, hooksFile, "agentStop")).toEqual({ decision: "block", reason: "read the updates" });
    situation = '- task t1 "Add a signup test" in shop, started by the user: waits for the user\'s approval';
    expect(hook(session, hooksFile, "userPromptSubmitted")).toEqual({ additionalContext: situation });
  });

  test("a session without a situation gets the empty output for its prompt", () => {
    const { session, hooksFile } = runningSession();

    expect(hook(session, hooksFile, "userPromptSubmitted")).toEqual({});
  });
});

describe("text the user puts into a session (ADR-68)", () => {
  test("is reported for typing and pasting, not for an answer to an approval, Esc or a terminal's own answers", () => {
    const { session, hooksFile, typedText } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "permission_prompt" }, omitted: [] })}\n`,
    );
    session.tick();
    session.input("1");
    session.input("\u001b");
    session.input("\u001b]11;rgb:0000/0000/0000\u001b\\");
    expect(typedText.count).toBe(0);

    endTurn(session, hooksFile);
    session.input("also add a test");
    session.input("\u001b[200~pasted\u001b[201~");

    expect(typedText.count).toBe(2);
  });

  test("an answer to an approval drawn before its hook is not the user's text, and the late hook does not ask again", async () => {
    const { session, hooksFile, typedText } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    const dialog = readFileSync(join(import.meta.dir, "fixtures", "copilot", "dialog-shell-72.txt"), "utf8");
    session.output(new TextEncoder().encode(dialog.replaceAll("\n", "\r\n")));
    await screenProcessed(session);

    session.input("1");
    expect(typedText.count).toBe(0);
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "permission_prompt" }, omitted: [] })}\n`,
    );
    session.tick();
    expect(session.view()?.state).toMatchObject({ state: "Working", source: "keyboard" });

    appendFileSync(hooksFile, `${JSON.stringify({ event: "postToolUse", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    await endTurnAtBox(session, hooksFile);
    expect(session.askToRead()).toBe("typed");
    expect(written).toEqual(["1", "read the review"]);
  });

  test("Ctrl+C on an approval drawn before its hook still counts as the user's, as before", async () => {
    const { session, hooksFile, typedText } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    const dialog = readFileSync(join(import.meta.dir, "fixtures", "copilot", "dialog-shell-72.txt"), "utf8");
    session.output(new TextEncoder().encode(dialog.replaceAll("\n", "\r\n")));
    await screenProcessed(session);

    session.input("\u0003");

    expect(typedText.count).toBe(1);
  });
});

describe("what the session's agent did, for its task's proposer (ADR-68)", () => {
  test("a turn ends with its agentStop hook, not with the Input a question dialog or an Esc gives in the middle of it", () => {
    const { session, hooksFile, events } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "elicitation_dialog" }, omitted: [] })}\n`,
    );
    session.tick();
    expect(session.view()?.state?.state).toBe("Input");
    expect(events).toEqual([]);

    endTurn(session, hooksFile);

    expect(events).toEqual([{ kind: "turn_ended" }]);
  });

  test("a turn after the user's text or Esc is the user's and gives nothing, the next one is not", () => {
    const { session, hooksFile, events } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    endTurn(session, hooksFile);
    session.input("rename foo\r");
    endTurn(session, hooksFile);
    session.input("\u001b");
    endTurn(session, hooksFile);
    endTurn(session, hooksFile);

    expect(events).toEqual([{ kind: "turn_ended" }, { kind: "turn_ended" }]);
  });

  test("the turn the daemon's prompt starts is not the user's, even after an Esc that ended no turn", async () => {
    const { session, hooksFile, events } = runningSession();
    session.connect({ write: () => {}, resize: () => {} });
    await endTurnAtBox(session, hooksFile);
    session.input("\u001b");

    expect(session.askToRead()).toBe("typed");
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    endTurn(session, hooksFile);

    expect(events).toEqual([{ kind: "turn_ended" }, { kind: "turn_ended" }]);
  });

  test("a crash is reported as the end of the process only, not also as an error", () => {
    let run: RunState = { kind: "running", runId: "r2", startedAt: "2026-10-24T12:00:00.000Z", pid: 1 };
    const { session, hooksFile, events } = runningSession(undefined, () => run);
    endTurn(session, hooksFile);
    run = {
      kind: "exited",
      runId: "r2",
      startedAt: "2026-10-24T12:00:00.000Z",
      endedAt: "2026-10-24T12:01:00.000Z",
      exitCode: null,
      signal: "SIGKILL",
      stoppedByUser: false,
      lastLines: [],
    };

    session.tick();

    expect(session.view()?.state?.state).toBe("Error");
    expect(events).toEqual([{ kind: "turn_ended" }, { kind: "exited", exitCode: null, stoppedByUser: false }]);
  });

  test("an error is reported once, and the end of the process with its exit code", () => {
    let run: RunState = { kind: "running", runId: "r2", startedAt: "2026-10-24T12:00:00.000Z", pid: 1 };
    const { session, hooksFile, events } = runningSession(undefined, () => run);
    for (const event of ["errorOccurred", "errorOccurred"])
      appendFileSync(hooksFile, `${JSON.stringify({ event, receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    run = {
      kind: "exited",
      runId: "r2",
      startedAt: "2026-10-24T12:00:00.000Z",
      endedAt: "2026-10-24T12:01:00.000Z",
      exitCode: 1,
      signal: null,
      stoppedByUser: false,
      lastLines: [],
    };

    session.tick();
    session.tick();

    expect(events).toEqual([{ kind: "error" }, { kind: "exited", exitCode: 1, stoppedByUser: false }]);
  });
});
