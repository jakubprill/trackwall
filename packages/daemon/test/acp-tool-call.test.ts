import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { toolCallFiles, toolCallLines, toolCallPatch } from "../src/modules/agents/acp-tool-call.ts";

const text = (t: string) => ({ type: "text" as const, text: t });
const CWD = join("/", "repo");

describe("the lines of a tool call", () => {
  test("an approval of a shell command shows the command", () => {
    expect(toolCallLines({ rawInput: { command: "npm test", commands: ["npm test"] } })).toEqual(["$ npm test"]);
  });

  test("a file diff is the tool's patch, not its lines", () => {
    expect(toolCallLines({ content: [{ type: "diff", path: "/repo/a.txt", oldText: "one", newText: "one\ntwo" }] })).toEqual([]);
  });

  test("a failed tool says why, and other output of a failed or running tool is not read", () => {
    expect(toolCallLines({ status: "failed", rawOutput: { message: "The user rejected this tool call." } })).toEqual([
      "The user rejected this tool call.",
    ]);
    expect(toolCallLines({ status: "completed", rawOutput: { message: "not shown" } })).toEqual([]);
  });

  test("a long output is cut at 64 Ki characters, also inside a line", () => {
    const lines = toolCallLines({ content: [{ type: "content", content: text(`${"a".repeat(60_000)}\n${"b".repeat(60_000)}\nc`) }] });

    expect(lines.map((l) => l.length)).toEqual([60_000, 64 * 1024 - 60_000]);
  });

  test("a long output is cut at 400 lines", () => {
    const lines = toolCallLines({
      content: [{ type: "content", content: text(Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")) }],
    });

    expect(lines).toHaveLength(400);
    expect(lines.at(-1)).toBe("line 399");
  });
});

describe("the files of a tool call", () => {
  test("a file in the working directory is relative to it, one outside keeps its path, and each comes once", () => {
    const inside = join(CWD, "src", "a.ts");
    const outside = join("/", "elsewhere", "b.ts");

    expect(toolCallFiles({ locations: [{ path: inside }, { path: outside }, { path: inside }] }, CWD)).toEqual([
      join("src", "a.ts"),
      outside,
    ]);
  });

  test("a tool without locations works on no files", () => {
    expect(toolCallFiles({}, CWD)).toEqual([]);
  });
});

describe("the patch of a tool call", () => {
  const gitDiff = "diff --git a/repo/a.txt b/repo/a.txt\n--- a/repo/a.txt\n+++ b/repo/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";

  test("a tool that ran has the git diff Copilot CLI sends in its output, without the empty line before it", () => {
    expect(toolCallPatch({ rawOutput: { content: "File updated.", detailedContent: `\n${gitDiff}` } })).toBe(gitDiff);
  });

  test("an approval of a file edit has the diff Copilot CLI sends in its input", () => {
    expect(toolCallPatch({ rawInput: { fileName: "/repo/a.txt", diff: `\n${gitDiff}` } })).toBe(gitDiff);
  });

  test("a shell tool's output is not a patch, even when it prints lines that start with a sign", () => {
    expect(toolCallPatch({ rawOutput: { detailedContent: "--- run 1 ---\n+ one passed\n- one failed" } })).toBe("");
  });

  test("without a git diff, the replaced and the new text of a diff content are a hunk without line numbers", () => {
    expect(toolCallPatch({ content: [{ type: "diff", path: "/repo/a.txt", oldText: "two\n", newText: "TWO\nthree\n" }] })).toBe(
      "diff --git a/repo/a.txt b/repo/a.txt\n--- a/repo/a.txt\n+++ b/repo/a.txt\n@@ @@\n-two\n+TWO\n+three\n",
    );
  });

  test("a new file's diff content has only added lines", () => {
    expect(toolCallPatch({ content: [{ type: "diff", path: "/repo/new.txt", oldText: "", newText: "hello" }] })).toBe(
      "diff --git a/repo/new.txt b/repo/new.txt\n--- a/repo/new.txt\n+++ b/repo/new.txt\n@@ @@\n+hello\n",
    );
  });

  test("a patch over 64 Ki characters is cut after its last whole line", () => {
    const line = `+${"x".repeat(99)}\n`;
    const patch = toolCallPatch({ rawInput: { diff: `--- a/f\n+++ b/f\n@@ -0,0 +1,1000 @@\n${line.repeat(1000)}` } });

    expect(patch.length).toBeLessThanOrEqual(64 * 1024);
    expect(patch.endsWith(line)).toBe(true);
  });
});
