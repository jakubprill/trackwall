import { describe, expect, test } from "bun:test";
import { hookRecord } from "../src/modules/agents/copilot-hook-record.ts";
import { stateFromHook } from "../src/modules/agents/copilot-hooks.ts";

describe("Copilot CLI hook record", () => {
  test("stores only the listed fields, and of the rest only the names", () => {
    const stdin = JSON.stringify({
      sessionId: "s1",
      timestamp: 1,
      cwd: "/repo",
      toolName: "bash",
      toolArgs: { command: "cat .env" },
      toolResult: { resultType: "success", textResultForLlm: "PASSWORD=secret" },
      somethingNew: "unknown field",
    });

    expect(hookRecord("postToolUse", stdin, 1000)).toEqual({
      event: "postToolUse",
      receivedAt: 1000,
      payload: { sessionId: "s1", timestamp: 1, toolName: "bash" },
      omitted: ["cwd", "toolArgs", "toolResult", "somethingNew"],
    });
  });

  test("a listed field that is neither a string nor a number is not stored, and long text is truncated", () => {
    const record = hookRecord("notification", JSON.stringify({ message: "x".repeat(2000), title: { nested: "PASSWORD" } }), 0);

    expect(record?.payload.message).toHaveLength(200);
    expect(record?.payload.title).toBeUndefined();
    expect(record?.omitted).toEqual(["title"]);
  });

  test("stdin that is not a JSON object gives no record", () => {
    expect(hookRecord("agentStop", "not json", 0)).toBeUndefined();
    expect(hookRecord("agentStop", "[1, 2]", 0)).toBeUndefined();
  });
});

describe("task state from Copilot CLI hooks", () => {
  test("session and turn events give a state with high or medium confidence", () => {
    expect(stateFromHook({ event: "sessionStart", receivedAt: 0, payload: {}, omitted: [] })).toMatchObject({
      state: "Input",
      confidence: "medium",
    });
    expect(stateFromHook({ event: "userPromptSubmitted", receivedAt: 0, payload: {}, omitted: [] })?.state).toBe("Working");
    expect(stateFromHook({ event: "postToolUse", receivedAt: 0, payload: {}, omitted: [] })?.state).toBe("Working");
    expect(stateFromHook({ event: "agentStop", receivedAt: 0, payload: { stopReason: "end_turn" }, omitted: [] })).toMatchObject({
      state: "Input",
      confidence: "high",
    });
    expect(stateFromHook({ event: "errorOccurred", receivedAt: 0, payload: {}, omitted: [] })?.state).toBe("Error");
  });

  test("the end of a session is Done or Error by reason and ends the session", () => {
    expect(stateFromHook({ event: "sessionEnd", receivedAt: 0, payload: { reason: "user_exit" }, omitted: [] })).toEqual({
      state: "Done",
      source: "hook",
      confidence: "high",
      reason: "hook sessionEnd user_exit",
      endsSession: true,
    });
    expect(stateFromHook({ event: "sessionEnd", receivedAt: 0, payload: { reason: "complete" }, omitted: [] })?.state).toBe("Done");
    expect(stateFromHook({ event: "sessionEnd", receivedAt: 0, payload: { reason: "error" }, omitted: [] })?.state).toBe("Error");
    expect(stateFromHook({ event: "sessionEnd", receivedAt: 0, payload: { reason: "timeout" }, omitted: [] })?.state).toBe("Error");
  });

  test("a notification with a kind is classified by kind, not by content; an approval request confirmed in a real session has high confidence", () => {
    expect(
      stateFromHook({
        event: "notification",
        receivedAt: 0,
        payload: { notification_type: "permission_prompt", title: "Permission needed", message: "Path permission needed: <path>" },
        omitted: [],
      }),
    ).toEqual({ state: "Approval", source: "hook", confidence: "high", reason: "hook notification permission_prompt" });
    expect(stateFromHook({ event: "notification", receivedAt: 0, payload: { type: "elicitation_dialog" }, omitted: [] })).toEqual({
      state: "Input",
      source: "hook",
      confidence: "medium",
      reason: "hook notification elicitation_dialog",
    });
  });

  test("notifications about background agents and commands and unknown kinds do not change the state", () => {
    expect(stateFromHook({ event: "notification", receivedAt: 0, payload: { type: "agent_idle" }, omitted: [] })).toBeUndefined();
    expect(stateFromHook({ event: "notification", receivedAt: 0, payload: { type: "agent_completed" }, omitted: [] })).toBeUndefined();
    expect(
      stateFromHook({ event: "notification", receivedAt: 0, payload: { notificationType: "plan_ready" }, omitted: [] }),
    ).toBeUndefined();
    expect(
      stateFromHook({
        event: "notification",
        receivedAt: 0,
        payload: { notificationType: "shell_completed", message: "Command needs permission" },
        omitted: [],
      }),
    ).toBeUndefined();
  });

  test("a notification without a kind is classified by whole words of its content with low confidence", () => {
    expect(stateFromHook({ event: "notification", receivedAt: 0, payload: { message: "Allow bash to run tests?" }, omitted: [] })).toEqual({
      state: "Approval",
      source: "hook",
      confidence: "low",
      reason: "hook notification (text)",
    });
    expect(stateFromHook({ event: "notification", receivedAt: 0, payload: { message: "Agent is idle" }, omitted: [] })?.state).toBe(
      "Input",
    );
    expect(
      stateFromHook({ event: "notification", receivedAt: 0, payload: { message: "Here is the explanation" }, omitted: [] }),
    ).toBeUndefined();
    expect(
      stateFromHook({ event: "notification", receivedAt: 0, payload: { message: "Background task finished" }, omitted: [] }),
    ).toBeUndefined();
  });
});
