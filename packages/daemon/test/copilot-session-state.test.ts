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
const noDialog = () => false;
const dialogOnScreen = () => true;

function sessionInTurn(): CopilotSessionState {
  const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });
  session.hook(promptSubmitted, noDialog);
  return session;
}

const states = (changes: readonly { state: string; reason: string }[]) => changes.map((c) => `${c.state} ${c.reason}`);

describe("approvals of tools the agent called at once (ADR-66)", () => {
  test("an answer to the first of two approval requests keeps the session waiting, and the answer to the second starts work", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest, noDialog);
    session.hook(approvalRequest, noDialog);

    expect(session.key("choice")).toEqual([]);
    expect(states(session.key("choice"))).toEqual(["Working key choice"]);
  });

  test("the postToolUse of another tool keeps the session waiting while an approval is on the screen, and is work without one", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest, noDialog);

    expect(session.hook(postToolUse, dialogOnScreen)).toEqual([]);
    expect(states(session.hook(postToolUse, noDialog))).toEqual(["Working hook postToolUse"]);
  });

  test("the postToolUse of the first approved of two keeps waiting, although the screen does not show the second dialog yet", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest, noDialog);
    session.hook(approvalRequest, noDialog);
    session.key("choice");

    expect(session.hook(postToolUse, noDialog)).toEqual([]);
    expect(states(session.key("choice"))).toEqual(["Working key choice"]);
  });

  test("Esc at the first of two approval requests ends the turn, and a later request needs only one answer", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest, noDialog);
    session.hook(approvalRequest, noDialog);
    expect(states(session.key("escape"))).toEqual(["Input key escape"]);

    session.hook(promptSubmitted, noDialog);
    session.hook(approvalRequest, noDialog);

    expect(states(session.key("choice"))).toEqual(["Working key choice"]);
  });

  test("a refusal of the first of two approval requests that cancels the turn ends waiting, although no hook comes", () => {
    const session = sessionInTurn();
    session.hook(approvalRequest, noDialog);
    session.hook(approvalRequest, noDialog);
    expect(session.key("enter")).toEqual([]);

    expect(states(session.output("\u25cf Operation cancelled by user\r\n"))).toEqual(["Input screen operation cancelled"]);
  });
});
