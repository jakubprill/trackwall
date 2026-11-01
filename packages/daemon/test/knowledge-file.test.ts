import { describe, expect, test } from "bun:test";
import type { KnowledgeEntry } from "@trackwall/protocol";
import { knowledgeNameOfFile, readKnowledgeFile, writeKnowledgeFile } from "../src/modules/knowledge/knowledge-file.ts";

const ENTRY: KnowledgeEntry = {
  name: "shop-integration-tests",
  kind: "how-to",
  repos: ["shop"],
  text: "Integration tests in shop run with mise run test-it;\nmise run test skips them.",
  evidence: "mise run test passed without running ShopIT.",
  writtenBy: { kind: "agent", task: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" },
  updatedAt: "2026-11-01T10:00:00.000Z",
};

describe("a knowledge entry as a file (ADR-170)", () => {
  test("an entry is frontmatter with its fields and the fact as the body, and reads back the same", () => {
    const text = writeKnowledgeFile(ENTRY);
    expect(text).toStartWith("---\nkind: how-to\nrepos:\n  - shop\n");
    expect(text).toEndWith("---\nIntegration tests in shop run with mise run test-it;\nmise run test skips them.\n");
    expect(readKnowledgeFile("shop-integration-tests", text)).toEqual({ entry: ENTRY });
  });

  test("the name comes from the file, never from the frontmatter", () => {
    const text = writeKnowledgeFile(ENTRY).replace("kind: how-to", "name: other\nkind: how-to");
    expect(readKnowledgeFile("shop-integration-tests", text)).toEqual({ entry: ENTRY });
  });

  test("a file edited into an unknown kind, an empty fact or hidden characters holds no entry", () => {
    expect(readKnowledgeFile("x", writeKnowledgeFile(ENTRY).replace("kind: how-to", "kind: rule"))).toMatchObject({
      problem: expect.stringContaining("kind"),
    });
    expect(readKnowledgeFile("x", writeKnowledgeFile({ ...ENTRY, text: " " }))).toMatchObject({
      problem: expect.stringContaining("the text"),
    });
    expect(readKnowledgeFile("x", writeKnowledgeFile({ ...ENTRY, text: "Run it.\u{E0049}" }))).toMatchObject({
      problem: expect.stringContaining("invisible characters"),
    });
  });

  test("only a Markdown file with a name of lowercase words is an entry", () => {
    expect(knowledgeNameOfFile("shop-integration-tests.md")).toBe("shop-integration-tests");
    expect(knowledgeNameOfFile("Shop.md")).toBeUndefined();
    expect(knowledgeNameOfFile("notes.txt")).toBeUndefined();
  });
});
