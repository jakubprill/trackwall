import { describe, expect, test } from "bun:test";
import { agentsApi, REJECTION_REASON_MAX, TaskPrompt, TaskTitle, visibleText } from "../src/agents.ts";

describe("text from an agent", () => {
  test("a task title is one line without control characters", () => {
    expect(TaskTitle.parse("  Add e-mail validation  ")).toBe("Add e-mail validation");
    expect(TaskTitle.safeParse("Add\nvalidation").success).toBe(false);
  });

  test("a prompt from an agent refuses characters a person would not see in the panel, and plain text with emoji passes", () => {
    const fromAgent = visibleText(TaskPrompt);
    expect(fromAgent.parse("Fix the test ✅\nCheck `pnpm test`.")).toBe("Fix the test ✅\nCheck `pnpm test`.");
    for (const hidden of ["\u{E0049}\u{E0047}\u{E004E}", "a\u200Bb", "abc\u202Edef", "line\u2028second", "\u{F0000}"]) {
      expect(fromAgent.safeParse(`Fix the test ${hidden}`).success).toBe(false);
    }
  });

  test("the tool's JSON schema gets no pattern a client without the u flag would not understand", () => {
    const schema = JSON.stringify(visibleText(TaskTitle).toJSONSchema());
    expect(schema).not.toContain("pattern");
  });
});

describe("rejecting a task proposal", () => {
  test("the reason is trimmed, and an empty or missing reason is no reason", () => {
    const parse = (reason?: string) => agentsApi.rejectProposal.request.parse({ proposal: "11111111-1111-4111-8111-111111111111", reason });
    expect(parse("  Do it in billing  ").reason).toBe("Do it in billing");
    expect(parse("   ").reason).toBeUndefined();
    expect(parse().reason).toBeUndefined();
  });

  test(`a reason longer than ${REJECTION_REASON_MAX} characters is refused`, () => {
    const request = { proposal: "11111111-1111-4111-8111-111111111111", reason: "x".repeat(REJECTION_REASON_MAX + 1) };
    expect(agentsApi.rejectProposal.request.safeParse(request).success).toBe(false);
  });
});
