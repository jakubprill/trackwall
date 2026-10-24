import { describe, expect, test } from "bun:test";
import { hookRecord } from "../src/modules/agents/copilot-hook-record.ts";
import { stateFromHook } from "../src/modules/agents/copilot-hooks.ts";

describe("rekord hooka Copilot CLI", () => {
  test("zapisuje tylko pola z listy, a o reszcie same nazwy", () => {
    const stdin = JSON.stringify({
      sessionId: "s1",
      timestamp: 1,
      cwd: "/repo",
      toolName: "bash",
      toolArgs: { command: "cat .env" },
      toolResult: { resultType: "success", textResultForLlm: "HASLO=tajne" },
      somethingNew: "nieznane pole",
    });

    expect(hookRecord("postToolUse", stdin, 1000)).toEqual({
      event: "postToolUse",
      receivedAt: 1000,
      payload: { sessionId: "s1", timestamp: 1, toolName: "bash" },
      omitted: ["cwd", "toolArgs", "toolResult", "somethingNew"],
    });
  });

  test("pole z listy, które nie jest napisem ani liczbą, nie jest zapisywane, a długi tekst jest przycinany", () => {
    const record = hookRecord("notification", JSON.stringify({ message: "x".repeat(2000), title: { nested: "HASLO" } }), 0);

    expect(record?.payload.message).toHaveLength(200);
    expect(record?.payload.title).toBeUndefined();
    expect(record?.omitted).toEqual(["title"]);
  });

  test("stdin, który nie jest obiektem JSON, nie daje rekordu", () => {
    expect(hookRecord("agentStop", "nie json", 0)).toBeUndefined();
    expect(hookRecord("agentStop", "[1, 2]", 0)).toBeUndefined();
  });
});

describe("stan zadania z hooków Copilot CLI", () => {
  test("zdarzenia sesji i tury dają stan z wysoką albo średnią pewnością", () => {
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

  test("koniec sesji to Done albo Error po powodzie i kończy sesję", () => {
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

  test("powiadomienie z rodzajem jest klasyfikowane po rodzaju, nie po treści", () => {
    expect(
      stateFromHook({
        event: "notification",
        receivedAt: 0,
        payload: { notification_type: "permission_prompt", message: "Copilot needs permission to run shell command" },
        omitted: [],
      }),
    ).toEqual({ state: "Approval", source: "hook", confidence: "medium", reason: "hook notification permission_prompt" });
    expect(stateFromHook({ event: "notification", receivedAt: 0, payload: { type: "elicitation_dialog" }, omitted: [] })?.state).toBe(
      "Input",
    );
  });

  test("powiadomienia o agentach i komendach w tle oraz nieznane rodzaje nie zmieniają stanu", () => {
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

  test("powiadomienie bez rodzaju jest klasyfikowane po całych słowach treści z niską pewnością", () => {
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
