import { describe, expect, test } from "bun:test";
import { RULE_FILES_MAX, ruleCandidates, ruleFiles } from "../src/modules/agents/repo-rules.ts";

describe("where a change's rules may be (ADR-234)", () => {
  test("the root's instructions, Copilot's instruction folder, the ADR folders and AGENTS.md above every changed file", () => {
    expect(ruleCandidates(["services/orders/src/Order.java", "README.md"])).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      ".github/copilot-instructions.md",
      ".github/instructions",
      "docs/adr",
      "docs/adrs",
      "docs/decisions",
      "docs/architecture/decisions",
      "doc/adr",
      "adr",
      "adrs",
      "services/AGENTS.md",
      "services/CLAUDE.md",
      "services/orders/AGENTS.md",
      "services/orders/CLAUDE.md",
      "services/orders/src/AGENTS.md",
      "services/orders/src/CLAUDE.md",
    ]);
  });
});

describe("which listed files are rules (ADR-234)", () => {
  test("instructions come first, root before nested before Copilot's path files, then the newest decision records", () => {
    const listed = [
      "docs/adr/0001-use-postgres.md",
      "docs/adr/0012-no-lombok.md",
      "docs/adr/0002-rest-only.md",
      "docs/adr/README.md",
      "docs/adr/template.md",
      "docs/adr/diagram.png",
      ".github/instructions/java.instructions.md",
      ".github/instructions/notes.md",
      "services/orders/AGENTS.md",
      ".github/copilot-instructions.md",
      "AGENTS.md",
    ];

    expect(ruleFiles(listed)).toEqual([
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "services/orders/AGENTS.md",
      ".github/instructions/java.instructions.md",
      "docs/adr/0012-no-lombok.md",
      "docs/adr/0002-rest-only.md",
      "docs/adr/0001-use-postgres.md",
    ]);
  });

  test("a repo with hundreds of decision records gives the check at most the limit, the instructions kept", () => {
    const records = Array.from({ length: 200 }, (_, i) => `docs/decisions/${String(i + 1).padStart(4, "0")}-decision.md`);

    const files = ruleFiles(["AGENTS.md", ...records]);

    expect(files).toHaveLength(RULE_FILES_MAX);
    expect(files[0]).toBe("AGENTS.md");
    expect(files[1]).toBe("docs/decisions/0200-decision.md");
  });

  test("a repo without any of them has no rules", () => {
    expect(ruleFiles(["README.md", "src/Main.java", "docs/guide.md"])).toEqual([]);
  });
});
