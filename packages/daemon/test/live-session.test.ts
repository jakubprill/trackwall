import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSession } from "../src/modules/agents/live-session.ts";

const sessions: LiveSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

describe("sesja Copilot CLI w daemonie", () => {
  test("klawisz liczy się ze stanu po hookach, które już są w hooks.jsonl, choć cykl odczytu jeszcze ich nie przeczytał", () => {
    const hooksFile = join(mkdtempSync(join(tmpdir(), "trackwall-session-")), "hooks.jsonl");
    writeFileSync(hooksFile, "");
    const written: string[] = [];
    const session = new LiveSession({
      id: "s1",
      repo: "sklep",
      task: null,
      cols: 80,
      rows: 24,
      hooksFile,
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

  test("the end of a turn waits for you until a session terminal window comes in front of the user", () => {
    const hooksFile = join(mkdtempSync(join(tmpdir(), "trackwall-session-")), "hooks.jsonl");
    writeFileSync(hooksFile, "");
    const session = new LiveSession({
      id: "s2",
      repo: "sklep",
      task: null,
      cols: 80,
      rows: 24,
      hooksFile,
      run: () => ({ kind: "running", runId: "r2", startedAt: "2026-10-24T12:00:00.000Z", pid: 1 }),
    });
    sessions.push(session);
    const window = session.attach(
      () => {},
      () => {},
      () => {},
    );
    appendFileSync(hooksFile, `${JSON.stringify({ event: "agentStop", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    expect(session.view()).toMatchObject({ state: { state: "Input", reason: "hook agentStop" }, needsAttention: true });

    window.focus(true);

    expect(session.view()).toMatchObject({ state: { state: "Input" }, needsAttention: false });
    window.detach();
  });
});
