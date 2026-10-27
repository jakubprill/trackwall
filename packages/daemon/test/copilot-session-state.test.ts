import { describe, expect, test } from "bun:test";
import type { CopilotHookRecord } from "../src/modules/agents/copilot-hook-record.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";

const approvalRequest: CopilotHookRecord = {
  event: "notification",
  receivedAt: 0,
  payload: { notification_type: "permission_prompt" },
  omitted: [],
};
const postToolUse: CopilotHookRecord = { event: "postToolUse", receivedAt: 0, payload: { toolName: "bash" }, omitted: [] };
const promptSubmitted: CopilotHookRecord = { event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] };

/** A session in the middle of a turn, at the time `clock.now`. */
function sessionInTurn(clock = { now: 0 }): CopilotSessionState {
  const session = new CopilotSessionState({ now: () => clock.now, staleAfterMs: 60_000, promptOnStart: false, program: null });
  session.hook(promptSubmitted);
  return session;
}

const states = (changes: readonly { state: string; reason: string }[]) => changes.map((c) => `${c.state} ${c.reason}`);

describe("approvals of tools the agent called at once (ADR-66)", () => {
  test("an answer to the first of two approval requests keeps the session waiting, and the answer to the second starts work", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest);
    session.hook(approvalRequest);

    expect(session.key("choice")).toEqual([]);
    expect(states(session.key("choice"))).toEqual(["Working key choice"]);
  });

  test("the postToolUse of another tool keeps the session waiting while the screen shows the approval", () => {
    const clock = { now: 0 };
    const session = sessionInTurn(clock);
    session.hook(approvalRequest);

    expect(session.hook(postToolUse)).toEqual([]);
    session.approvalOnScreen();
    clock.now = 10_000;

    expect(session.tick()).toBeUndefined();
    expect(states(session.key("choice"))).toEqual(["Working key choice"]);
  });

  test("a postToolUse whose approval the screen does not show within 3 s is work, as when the answer was not seen", () => {
    const clock = { now: 0 };
    const session = sessionInTurn(clock);
    session.hook(approvalRequest);
    expect(session.hook(postToolUse)).toEqual([]);

    clock.now = 2999;
    expect(session.tick()).toBeUndefined();
    clock.now = 3000;
    expect(session.tick()).toMatchObject({ state: "Working", reason: "hook postToolUse" });
  });

  test("the postToolUse of the first approved of two keeps waiting while the second dialog is drawn", () => {
    const clock = { now: 0 };
    const session = sessionInTurn(clock);
    session.hook(approvalRequest);
    session.hook(approvalRequest);
    session.key("choice");

    expect(session.hook(postToolUse)).toEqual([]);
    clock.now = 500;
    session.approvalOnScreen();
    clock.now = 10_000;

    expect(session.tick()).toBeUndefined();
    expect(states(session.key("choice"))).toEqual(["Working key choice"]);
  });

  test("an approval guessed from a notification's text ends with the next postToolUse at once, as before", () => {
    const session = sessionInTurn();
    session.hook({ event: "notification", receivedAt: 0, payload: { message: "Allow bash to run the tests?" }, omitted: [] });

    expect(states(session.hook(postToolUse))).toEqual(["Working hook postToolUse"]);
  });

  test("Esc at the first of two approval requests ends the turn, and a later request needs only one answer", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest);
    session.hook(approvalRequest);
    expect(states(session.key("escape"))).toEqual(["Input key escape"]);

    session.hook(promptSubmitted);
    session.hook(approvalRequest);

    expect(states(session.key("choice"))).toEqual(["Working key choice"]);
  });

  test("a refusal of the first of two approval requests that cancels the turn ends waiting, although no hook comes", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest);
    session.hook(approvalRequest);
    expect(session.key("enter")).toEqual([]);

    expect(states(session.output("● Operation cancelled by user\r\n"))).toEqual(["Input screen operation cancelled"]);
  });
});
