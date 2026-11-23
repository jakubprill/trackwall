import { describe, expect, test } from "bun:test";
import type { Session, WaitStatus } from "@trackwall/protocol";
import { outcome, sessionWaitStatus, waitUntilSettled } from "../src/modules/agents/session-wait.ts";

describe("waiting for a session", () => {
  test("the wait lasts while the state is in progress, and ends at the first state that needs someone", async () => {
    const states: WaitStatus[] = ["starting", "working", "needs_attention", "working"];
    let reads = 0;
    const result = await waitUntilSettled(() => outcome(states[reads++] ?? "working"), 5000, new AbortController().signal);
    expect(result.status).toBe("needs_attention");
    expect(reads).toBe(3);
  });

  test("after the time limit the wait returns the last in-progress state, not an error", async () => {
    const started = Date.now();
    const result = await waitUntilSettled(() => outcome("working"), 300, new AbortController().signal);
    expect(result.status).toBe("working");
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  test("a wait cancelled by the client ends at once with the state at the moment of cancelling", async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 50);
    const result = await waitUntilSettled(() => outcome("proposal_pending"), 30_000, abort.signal);
    expect(result.status).toBe("proposal_pending");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

const working: Session = {
  id: "s1",
  repo: "api",
  supervisor: false,
  startedAt: "2026-10-31T09:00:00.000Z",
  run: { kind: "running", runId: "r1", startedAt: "2026-10-31T09:00:00.000Z", pid: 4242 },
  state: { state: "Working", source: "hook", confidence: "high", reason: "hook postToolUse", at: "2026-10-31T09:00:00.000Z" },
  windowTitle: null,
  needsAttention: false,
  waitingSince: null,
  stuck: null,
  task: null,
  dialog: null,
  environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
  view: "terminal",
  readRequest: null,
  copyRequest: null,
  usage: null,
  model: null,
  modelInUse: null,
  modelError: null,
  tokenBudget: null,
};

describe("what wait_for_session sees of a session", () => {
  test("a working session goes on being waited for", () => {
    expect(sessionWaitStatus(working)).toBe("working");
  });

  test("a working session that may be stuck ends the wait as stale, like one that does not respond (ADR-151)", () => {
    expect(sessionWaitStatus({ ...working, stuck: { lastStepAt: "2026-10-31T09:00:00.000Z" } })).toBe("stale");
  });
});

const turnEnded = { state: "Input", source: "hook", confidence: "high", reason: "hook agentStop", at: "2026-10-31T09:05:00.000Z" } as const;
const inInputBox: Session = { ...working, state: turnEnded };

describe("when wait_for_session says another agent is done or blocked", () => {
  test("a session that ended its turn and waits for the user ends the wait as needs_attention", () => {
    expect(sessionWaitStatus({ ...inInputBox, needsAttention: true })).toBe("needs_attention");
  });

  test("a session that ended its turn, which the user has already seen, ends the wait as idle instead of working on", () => {
    expect(sessionWaitStatus({ ...inInputBox, needsAttention: false })).toBe("idle");
  });

  test("a session blocked on an approval or a plan approval ends the wait as needs_attention", () => {
    for (const state of ["Approval", "Plan"] as const)
      expect(sessionWaitStatus({ ...working, needsAttention: true, state: { ...turnEnded, state } })).toBe("needs_attention");
  });

  test("a session whose input box has a message on its way to the agent goes on being waited for", () => {
    for (const waitsFor of ["sent", "pending"] as const) {
      const readRequest = { prompt: "Read your messages with get_messages.", since: "2026-10-31T09:06:00.000Z", waitsFor };
      expect(sessionWaitStatus({ ...inInputBox, needsAttention: true, readRequest })).toBe("working");
      expect(sessionWaitStatus({ ...inInputBox, needsAttention: false, readRequest })).toBe("working");
    }
  });

  test("a message nothing will deliver (text in the input box, no turn to end) does not keep the wait going", () => {
    for (const waitsFor of ["user_text", "idle"] as const) {
      const readRequest = { prompt: "Read your messages with get_messages.", since: "2026-10-31T09:06:00.000Z", waitsFor };
      expect(sessionWaitStatus({ ...inInputBox, needsAttention: true, readRequest })).toBe("needs_attention");
      expect(sessionWaitStatus({ ...inInputBox, needsAttention: false, readRequest })).toBe("idle");
    }
  });
});
