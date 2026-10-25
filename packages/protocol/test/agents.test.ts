import { describe, expect, test } from "bun:test";
import { agentsApi, REJECTION_REASON_MAX, TaskPrompt, TaskTitle, visibleText } from "../src/agents.ts";

describe("tekst od agenta", () => {
  test("tytuł zadania to jedna linia bez znaków sterujących", () => {
    expect(TaskTitle.parse("  Dodaj walidację e-maila  ")).toBe("Dodaj walidację e-maila");
    expect(TaskTitle.safeParse("Dodaj\nwalidację").success).toBe(false);
  });

  test("polecenie od agenta odrzuca znaki, których człowiek w panelu nie zobaczy, a zwykły tekst z emoji przechodzi", () => {
    const fromAgent = visibleText(TaskPrompt);
    expect(fromAgent.parse("Napraw test ✅\nSprawdź `pnpm test`.")).toBe("Napraw test ✅\nSprawdź `pnpm test`.");
    for (const hidden of ["\u{E0049}\u{E0047}\u{E004E}", "a\u200Bb", "abc\u202Edef", "linia\u2028druga", "\u{F0000}"]) {
      expect(fromAgent.safeParse(`Napraw test ${hidden}`).success).toBe(false);
    }
  });

  test("schemat JSON narzędzia nie dostaje wzorca, którego klient bez flagi u nie zrozumie", () => {
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
