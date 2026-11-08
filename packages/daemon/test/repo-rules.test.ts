import { describe, expect, test } from "bun:test";
import {
  FIXED_RULE_PLACES,
  nestedCandidates,
  RULE_FILES_MAX,
  type RulesVcs,
  readRepoRules,
  ruleFiles,
} from "../src/modules/agents/repo-rules.ts";

describe("where a change's rules may be (ADR-234)", () => {
  test("the root's instructions, Copilot's instruction folder and the ADR folders are fixed places", () => {
    expect(FIXED_RULE_PLACES).toEqual([
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
    ]);
  });

  test("AGENTS.md and CLAUDE.md count in every folder above a changed file", () => {
    expect(nestedCandidates(["services/orders/src/Order.java", "README.md"])).toEqual([
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

  test("a repo without any of them has no rules", () => {
    expect(ruleFiles(["README.md", "src/Main.java", "docs/guide.md"])).toEqual([]);
  });
});

describe("reading a change's rules from the base commit (ADR-234)", () => {
  /** A base commit with `files`; records what git got as arguments and on its standard input. */
  function baseCommit(files: Record<string, string>, listCut = false) {
    const calls: { listed: (readonly string[])[]; read: number[] } = { listed: [], read: [] };
    const vcs: RulesVcs = {
      filesAt: async (_dir, _commit, paths) => {
        calls.listed.push(paths);
        const inside = Object.keys(files).filter((file) => paths.some((p) => file === p || file.startsWith(`${p}/`)));
        return { paths: inside, truncated: listCut };
      },
      readFiles: async (_dir, _commit, paths) => {
        calls.read.push(paths.length);
        return new Map(paths.filter((p) => p in files).map((p) => [p, Buffer.from(files[p] ?? "")]));
      },
    };
    return { vcs, calls };
  }

  test("a change across thousands of folders asks git about their AGENTS.md on its input, not on the command line", async () => {
    const changed = Array.from({ length: 3000 }, (_, i) => `module-${i}/src/main/java/App${i}.java`);
    const { vcs, calls } = baseCommit({ "AGENTS.md": "root", "module-7/AGENTS.md": "module 7" });

    const rules = await readRepoRules(vcs, "/work", "base", changed);

    expect(calls.listed).toEqual([[...FIXED_RULE_PLACES]]);
    expect(calls.read[0]).toBe(nestedCandidates(changed).length);
    expect([...rules.files.keys()]).toEqual(["AGENTS.md", "module-7/AGENTS.md"]);
    expect(rules.omitted).toBe(0);
  });

  test("hundreds of decision records give the check at most the limit, the instructions kept, and count the rest", async () => {
    const records = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`docs/decisions/${String(i + 1).padStart(4, "0")}-decision.md`, "a decision"]),
    );
    const { vcs } = baseCommit({ "AGENTS.md": "root", ...records });

    const rules = await readRepoRules(vcs, "/work", "base", ["src/App.java"]);

    const taken = [...rules.files.keys()];
    expect(taken).toHaveLength(RULE_FILES_MAX);
    expect(taken.slice(0, 2)).toEqual(["AGENTS.md", "docs/decisions/0200-decision.md"]);
    expect(rules.omitted).toBe(201 - RULE_FILES_MAX);
  });

  test("a listing git cut counts as a rule file left out", async () => {
    const { vcs } = baseCommit({ "AGENTS.md": "root" }, true);

    expect((await readRepoRules(vcs, "/work", "base", ["a.ts"])).omitted).toBe(1);
  });
});
