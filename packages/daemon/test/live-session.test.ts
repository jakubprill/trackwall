import { afterEach, describe, expect, test } from "bun:test";
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

/** A running session with an empty `hooks.jsonl`; the hook records are the input of each test. */
function runningSession(): { session: LiveSession; hooksFile: string } {
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
  });
  sessions.push(session);
  return { session, hooksFile };
}

function endTurn(session: LiveSession, hooksFile: string): void {
  appendFileSync(hooksFile, `${JSON.stringify({ event: "agentStop", receivedAt: 0, payload: {}, omitted: [] })}\n`);
  session.tick();
}

describe("a prompt the daemon types into a session (a review, ADR-62)", () => {
  test("goes in only once the session waits for input, with Enter written separately after the text", async () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);

    expect(session.typePrompt("read the review")).toBe("queued");
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

    expect(session.typePrompt("read the review")).toBe("typed");

    expect(written).toEqual(["read the review"]);
    expect(session.view()?.needsAttention).toBe(true);
  });

  test("is typed once: a second prompt before Copilot CLI takes the first changes nothing", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    endTurn(session, hooksFile);

    expect(session.typePrompt("read the review")).toBe("typed");
    expect(session.typePrompt("read the review")).toBe("typed");

    expect(written).toEqual(["read the review"]);
  });

  test("waits after an Esc and for a question dialog, which leave the session in Input but not in its input box", () => {
    const { session, hooksFile } = runningSession();
    const written: string[] = [];
    session.connect({ write: (data) => written.push(data), resize: () => {} });
    appendFileSync(hooksFile, `${JSON.stringify({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    session.input("\u001b");
    expect(session.typePrompt("read the review")).toBe("queued");
    appendFileSync(
      hooksFile,
      `${JSON.stringify({ event: "notification", receivedAt: 0, payload: { notification_type: "elicitation_dialog" }, omitted: [] })}\n`,
    );
    session.tick();
    expect(written).toEqual(["\u001b"]);

    endTurn(session, hooksFile);

    expect(written).toEqual(["\u001b", "read the review"]);
  });
});
