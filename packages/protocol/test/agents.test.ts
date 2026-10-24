import { describe, expect, test } from "bun:test";
import { TaskPrompt, TaskTitle, visibleText } from "../src/agents.ts";

describe("tekst od agenta", () => {
  test("tytuł zadania to jedna linia bez znaków sterujących", () => {
    expect(TaskTitle.parse("  Dodaj walidację e-maila  ")).toBe("Dodaj walidację e-maila");
    expect(TaskTitle.safeParse("Dodaj\nwalidację").success).toBe(false);
  });

  test("polecenie od agenta odrzuca znaki, których człowiek w panelu nie zobaczy, a zwykły tekst z emoji przechodzi", () => {
    const fromAgent = visibleText(TaskPrompt);
    expect(fromAgent.parse("Napraw test ✅\nSprawdź `pnpm test`.")).toBe("Napraw test ✅\nSprawdź `pnpm test`.");
    for (const hidden of ["\u{E0049}\u{E0047}\u{E004E}", "a​b", "abc‮def", "linia druga", "\u{F0000}"]) {
      expect(fromAgent.safeParse(`Napraw test ${hidden}`).success).toBe(false);
    }
  });

  test("schemat JSON narzędzia nie dostaje wzorca, którego klient bez flagi u nie zrozumie", () => {
    const schema = JSON.stringify(visibleText(TaskTitle).toJSONSchema());
    expect(schema).not.toContain("pattern");
  });
});
