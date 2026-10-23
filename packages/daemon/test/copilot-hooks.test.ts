import { describe, expect, test } from "bun:test";
import { hookRecord, stateFromHook } from "../src/modules/agents/copilot-hooks.ts";

describe("hooki Copilot CLI", () => {
  test("rekord hooka nie zapisuje promptu, argumentów i wyniku narzędzi ani ścieżki transkryptu", () => {
    const stdin = JSON.stringify({
      sessionId: "s1",
      timestamp: 1,
      cwd: "/repo",
      toolName: "bash",
      toolArgs: { command: "cat .env" },
      toolResult: { resultType: "success", textResultForLlm: "HASLO=tajne" },
    });

    expect(hookRecord("postToolUse", stdin, 1000)).toEqual({
      event: "postToolUse",
      at: 1000,
      payload: { sessionId: "s1", timestamp: 1, cwd: "/repo", toolName: "bash" },
    });
  });

  test("długie pole tekstowe jest przycinane, a stdin, który nie jest obiektem JSON, nie daje rekordu", () => {
    expect(hookRecord("errorOccurred", JSON.stringify({ message: "x".repeat(2000) }), 0)?.payload.message).toHaveLength(500);
    expect(hookRecord("agentStop", "nie json", 0)).toBeUndefined();
    expect(hookRecord("agentStop", "[1, 2]", 0)).toBeUndefined();
  });

  test("zdarzenia hooków dają stan zadania", () => {
    const state = (event: Parameters<typeof hookRecord>[0], payload: Record<string, unknown> = {}) =>
      stateFromHook({ event, at: 0, payload })?.state;

    expect(state("sessionStart")).toBe("Input");
    expect(state("userPromptSubmitted")).toBe("Working");
    expect(state("postToolUse")).toBe("Working");
    expect(state("agentStop", { stopReason: "end_turn" })).toBe("Input");
    expect(state("errorOccurred")).toBe("Error");
    expect(state("sessionEnd", { reason: "complete" })).toBe("Done");
    expect(state("sessionEnd", { reason: "user_exit" })).toBe("Done");
    expect(state("sessionEnd", { reason: "error" })).toBe("Error");
    expect(state("sessionEnd", { reason: "timeout" })).toBe("Error");
  });

  test("powiadomienie jest klasyfikowane po rodzaju i treści, a nieznane nie zmienia stanu", () => {
    const notification = (payload: Record<string, unknown>) => stateFromHook({ event: "notification", at: 0, payload });

    expect(notification({ notification_type: "permission_prompt", message: "Allow bash?" })).toEqual({
      state: "Approval",
      source: "hook",
      confidence: "medium",
      reason: "hook notification permission_prompt",
    });
    expect(notification({ notificationType: "plan_ready" })?.state).toBe("Plan");
    expect(notification({ type: "elicitation_dialog" })?.state).toBe("Input");
    expect(notification({ message: "Agent is idle" })?.state).toBe("Input");
    expect(notification({ notificationType: "shell_completed", message: "Command completed" })).toBeUndefined();
    expect(notification({ notificationType: "update_available" })).toBeUndefined();
  });
});
