import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSession } from "../src/modules/agents/live-session.ts";

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
      task: null,
      cols: 80,
      rows: 24,
      hooksFile,
      promptOnStart: false,
      run: () => ({ kind: "running", runId: "r1", startedAt: "2026-10-24T12:00:00.000Z", pid: 1 }),
      prompt: () => undefined,
      onUserText: () => {},
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
 * for it (its daemon prompt), and `typedText` counts how often the user put text into it.
 */
function runningSession(prompt: () => string | undefined = () => "read the review"): {
  session: LiveSession;
  hooksFile: string;
  typedText: { count: number };
} {
  const typedText = { count: 0 };
  const hooksFile = join(mkdtempSync(join(tmpdir(), "trackwall-session-")), "hooks.jsonl");
  writeFileSync(hooksFile, "");
  const session = new LiveSession({
    id: "s2",
    repo: "shop",
    task: null,
    cols: 80,
    rows: 24,
    hooksFile,
    promptOnStart: false,
    run: () => ({ kind: "running", runId: "r2", startedAt: "2026-10-24T12:00:00.000Z", pid: 1 }),
    prompt,
    onUserText: () => {
      typedText.count++;
    },
  });
  sessions.push(session);
  return { session, hooksFile, typedText };
}

function endTurn(session: LiveSession, hooksFile: string): void {
  appendFileSync(hooksFile, `${JSON.stringify({ event: "agentStop", receivedAt: 0, payload: {}, omitted: [] })}\n`);
  session.tick();
}

describe("a prompt the daemon types into a session (a review, ADR-62, or a message or update, ADR-68)", () => {
  test("goes in only once the session waits for input, with Enter written separately after the text", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);

    expect(session.askToRead()).toBe("queued");
    expect(written).toEqual([]);

    endTurn(session, hooksFile);
    expect(written).toEqual(["read the review"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(written).toEqual(["read the review", "\r"]);
  });

  test("goes in at once while the session waits for input, and does not mark the end of the turn seen", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    endTurn(session, hooksFile);

    expect(session.askToRead()).toBe("typed");

    expect(written).toEqual(["read the review"]);
    expect(session.view()?.needsAttention).toBe(true);
  });

  test("is typed once: a second prompt before Copilot CLI takes the first changes nothing", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    endTurn(session, hooksFile);

    expect(session.askToRead()).toBe("typed");
    expect(session.askToRead()).toBe("typed");

    expect(written).toEqual(["read the review"]);
  });

  test("waits after an Esc and for a question dialog, which leave the session in Input but not in its input box", () => {
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

    endTurn(session, hooksFile);

    expect(written).toEqual(["\u001b", "read the review"]);
  });

  test("waits for a question dialog right after the start, which the state alone does not show", () => {
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

  test("waits while the user is typing a message of their own", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    endTurn(session, hooksFile);
    session.input("also check the");

    expect(session.askToRead()).toBe("queued");
    expect(written).toEqual(["also check the"]);
  });

  test("is typed again when the session has not taken it after 5 s", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    endTurn(session, hooksFile);
    session.askToRead();

    setSystemTime(new Date(Date.now() + 6000));
    try {
      expect(session.askToRead()).toBe("typed");
    } finally {
      setSystemTime();
    }

    expect(written).toEqual(["read the review", "read the review"]);
  });

  test("a background shell finishing does not take the session out of its input box", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    endTurn(session, hooksFile);
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "shell_completed" }, omitted: [] })}\n`,
    );

    expect(session.askToRead()).toBe("typed");
    expect(written).toEqual(["read the review"]);
  });

  test("waits for text the user typed during the turn and has not sent, and for a turn that started again in the same read", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    session.input("next, rename foo");
    session.askToRead();
    endTurn(session, hooksFile);
    expect(written).toEqual(["next, rename foo"]);

    for (const event of ["userPromptSubmitted", "agentStop", "userPromptSubmitted"])
      appendFileSync(hooksFile, `${JSON.stringify({ event, receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();

    expect(written).toEqual(["next, rename foo"]);
  });

  test("a request the typed prompt does not cover goes in after the turn that prompt starts, with the prompt read then", () => {
    let waiting = "read the review";
    const { session, hooksFile } = runningSession(() => waiting);
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    endTurn(session, hooksFile);
    expect(session.askToRead()).toBe("typed");

    waiting = "read the review and the message";
    expect(session.askToRead()).toBe("queued");
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    waiting = "read the message";
    endTurn(session, hooksFile);

    expect(written).toEqual(["read the review", "read the message"]);
  });

  test("types nothing when everything was read before the session got back to its input box", () => {
    let waiting: string | undefined = "read the message";
    const { session, hooksFile } = runningSession(() => waiting);
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    expect(session.askToRead()).toBe("queued");

    waiting = undefined;
    endTurn(session, hooksFile);
    waiting = "read the message";
    session.tick();

    expect(written).toEqual([]);
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
});
