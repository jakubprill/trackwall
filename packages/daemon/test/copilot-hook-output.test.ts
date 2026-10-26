import { describe, expect, test } from "bun:test";
import { hookOutputFor } from "../src/modules/agents/copilot-hook-output.ts";

const waiting = { blockedTurn: false, prompt: "read the review", contextGiven: undefined, userDraft: false };

describe("the hook output for what waits for a session (ADR-85)", () => {
  test("the end of a turn is blocked with the prompt as the next turn's message", () => {
    expect(hookOutputFor({ ...waiting, event: "agentStop" })).toEqual({ decision: "block", reason: "read the review" });
  });

  test("the end of a turn a block started, or one with the user's draft in the box, is not blocked", () => {
    expect(hookOutputFor({ ...waiting, event: "agentStop", blockedTurn: true })).toEqual({});
    expect(hookOutputFor({ ...waiting, event: "agentStop", userDraft: true })).toEqual({});
  });

  test("a tool's result carries the prompt unless the same prompt went with one in this turn", () => {
    expect(hookOutputFor({ ...waiting, event: "postToolUse" })).toEqual({ additionalContext: "read the review" });
    expect(hookOutputFor({ ...waiting, event: "postToolUse", contextGiven: "read the review" })).toEqual({});
    expect(hookOutputFor({ ...waiting, event: "postToolUse", contextGiven: "read the message" })).toEqual({
      additionalContext: "read the review",
    });
  });

  test("nothing unread, or any other hook, gets the empty output", () => {
    expect(hookOutputFor({ ...waiting, event: "agentStop", prompt: undefined })).toEqual({});
    expect(hookOutputFor({ ...waiting, event: "postToolUse", prompt: undefined })).toEqual({});
    expect(hookOutputFor({ ...waiting, event: "userPromptSubmitted" })).toEqual({});
    expect(hookOutputFor({ ...waiting, event: "notification" })).toEqual({});
  });
});
