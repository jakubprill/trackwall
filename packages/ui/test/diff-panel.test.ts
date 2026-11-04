import { describe, expect, test } from "bun:test";
import type { ConversationEntry } from "@trackwall/protocol";
import { conversationTurns } from "../src/lib/conversation.ts";
import { askAboutLine, inFileAsLeft, shownDiff, turnFiles } from "../src/lib/diff-panel.ts";

function edit(id: string, files: string[], patch: string): Extract<ConversationEntry, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    title: "Edit file",
    tool: "edit",
    status: "completed",
    files,
    detail: [],
    patch,
    patchCut: false,
    subagent: null,
  };
}

const TOTAL_PATCH =
  "diff --git a/src/total.ts b/src/total.ts\n--- a/src/total.ts\n+++ b/src/total.ts\n@@ -3,2 +3,2 @@\n const a = 1;\n-return a;\n+return a - discount;\n";
const SUMMARY_PATCH =
  'diff --git a/src/Summary.tsx b/src/Summary.tsx\n--- a/src/Summary.tsx\n+++ b/src/Summary.tsx\n@@ -10,1 +10,2 @@\n <Row />\n+<Row label="Discount" />\n';
const SUMMARY_AGAIN =
  "diff --git a/src/Summary.tsx b/src/Summary.tsx\n--- a/src/Summary.tsx\n+++ b/src/Summary.tsx\n@@ -20,1 +20,1 @@\n-<Total />\n+<Total discounted />\n";

describe("the diff panel of the conversation view", () => {
  test("a turn's files are the files of its changes, in the order it first changed them, with a file changed twice as one file with both changes", () => {
    const files = turnFiles([
      edit("tool-1", ["src/Summary.tsx"], SUMMARY_PATCH),
      { id: "agent-1", kind: "agent", text: "Now the total." },
      edit("tool-2", ["src/total.ts"], TOTAL_PATCH),
      edit("tool-3", ["src/Summary.tsx"], SUMMARY_AGAIN),
      { ...edit("tool-4", [], ""), title: "Run tests", tool: "execute" },
    ]);

    expect(files.map((f) => [f.path, f.added, f.removed, f.changes.map((c) => c.tool)])).toEqual([
      ["src/Summary.tsx", 2, 1, ["tool-1", "tool-3"]],
      ["src/total.ts", 1, 1, ["tool-2"]],
    ]);
    expect(files[1]?.changes[0]?.change.lines.map((l) => [l.anchor?.line ?? null, l.text])).toEqual([
      [null, "@@ -3,2 +3,2 @@"],
      [3, " const a = 1;"],
      [4, "-return a;"],
      [4, "+return a - discount;"],
    ]);
  });

  test("the panel shows the file the user picked in its turn, and without a pick the first file of the last turn that changed one", () => {
    const turns = conversationTurns([
      { id: "user-1", kind: "user", text: "Fix the total", attachments: [] },
      edit("tool-1", ["src/total.ts"], TOTAL_PATCH),
      edit("tool-2", ["src/Summary.tsx"], SUMMARY_PATCH),
      { id: "user-2", kind: "user", text: "Thanks", attachments: [] },
      { id: "agent-2", kind: "agent", text: "You're welcome." },
    ]);

    expect(shownDiff(turns, { turn: "tool-1", path: "src/Summary.tsx" })).toMatchObject({
      turn: "tool-1",
      file: { path: "src/Summary.tsx" },
    });
    expect(shownDiff(turns, null)).toMatchObject({ turn: "tool-1", file: { path: "src/total.ts" } });
    expect(shownDiff(turns, { turn: "gone-after-a-reset", path: "src/Summary.tsx" })).toMatchObject({ file: { path: "src/total.ts" } });
    expect(shownDiff(conversationTurns([{ id: "agent-1", kind: "agent", text: "Nothing changed." }]), null)).toBeNull();
  });

  test("a call that changed two files is two files, named as the daemon named them though the patch has their absolute paths", () => {
    const patch =
      "diff --git a/home/me/shop/src/a.ts b/home/me/shop/src/a.ts\n--- a/home/me/shop/src/a.ts\n+++ b/home/me/shop/src/a.ts\n@@ -1,1 +1,1 @@\n-one\n+ONE\n" +
      "diff --git a/home/me/shop/src/b.ts b/home/me/shop/src/b.ts\n--- a/home/me/shop/src/b.ts\n+++ b/home/me/shop/src/b.ts\n@@ -7,0 +7,1 @@\n+two\n";

    const files = turnFiles([edit("tool-1", ["src/a.ts", "src/b.ts"], patch)]);

    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/a.ts", 1, 1],
      ["src/b.ts", 1, 0],
    ]);
    expect(files[1]?.changes[0]?.change.lines.map((l) => l.text)).toEqual(["@@ -7,0 +7,1 @@", "+two"]);
    // A review comment and VS Code get the name the daemon knows, not the patch's absolute path.
    expect(files[1]?.changes[0]?.change.lines[1]?.anchor).toEqual({ path: "src/b.ts", side: "new", line: 7 });
    expect(files.map((f) => f.known)).toEqual([true, true]);
    // Without the daemon's names the patch's paths stay, and their lines are not offered for a comment or VS Code.
    const unnamed = turnFiles([edit("tool-2", [], patch)]);
    expect(unnamed.map((f) => [f.path, f.known])).toEqual([
      ["home/me/shop/src/a.ts", false],
      ["home/me/shop/src/b.ts", false],
    ]);
    // A file outside the working directory keeps its absolute path, which a review or VS Code cannot take either.
    const config = '--- a/home/me/.config/x.json\n+++ b/home/me/.config/x.json\n@@ -1,1 +1,1 @@\n-{}\n+{ "a": 1 }\n';
    expect(turnFiles([edit("tool-5", ["/home/me/.config/x.json"], config)]).map((f) => [f.path, f.known])).toEqual([
      ["/home/me/.config/x.json", false],
    ]);
    expect(turnFiles([edit("tool-6", ["C:\\Users\\me\\x.json"], config)]).map((f) => f.known)).toEqual([false]);
    const similar =
      "diff --git a/home/me/shop/data.ts b/home/me/shop/data.ts\n--- a/home/me/shop/data.ts\n+++ b/home/me/shop/data.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    expect(turnFiles([edit("tool-3", ["a.ts", "data.ts"], similar)]).map((f) => f.path)).toEqual(["data.ts"]);
    const binary = "diff --git a/home/me/shop/logo.png b/home/me/shop/logo.png\nBinary files differ\n";
    expect(turnFiles([edit("tool-4", ["logo.png"], binary)])).toEqual([]);
  });

  test("only the conversation's last change of a file is numbered as the file is now, so a later turn's change of it makes an earlier one past", () => {
    const turns = conversationTurns([
      { id: "user-1", kind: "user", text: "Add a discount row", attachments: [] },
      edit("tool-1", ["src/Summary.tsx"], SUMMARY_PATCH),
      edit("tool-2", ["src/total.ts"], TOTAL_PATCH),
      { id: "user-2", kind: "user", text: "Show the discounted total", attachments: [] },
      edit("tool-3", ["src/Summary.tsx"], SUMMARY_AGAIN),
    ]);

    expect(shownDiff(turns, { turn: "tool-1", path: "src/Summary.tsx" })?.current).toBeNull();
    expect(shownDiff(turns, { turn: "tool-1", path: "src/total.ts" })?.current).toBe("tool-2");
    expect(shownDiff(turns, { turn: "tool-3", path: "src/Summary.tsx" })?.current).toBe("tool-3");
    const unnamed = conversationTurns([edit("tool-4", [], TOTAL_PATCH)]);
    expect(shownDiff(unnamed, null)?.current).toBeNull();
  });

  test("a line of the file as the agent left it takes a comment and opens in VS Code, and any line can be asked about as a quote", () => {
    expect(inFileAsLeft({ path: "src/a.ts", side: "new", line: 3 })).toBe(true);
    expect(inFileAsLeft({ path: "src/a.ts", side: "old", line: 3 })).toBe(false);
    expect(askAboutLine({ path: "src/Summary.tsx", side: "new", line: 14 }, '+  <Row label="Discount" />')).toBe(
      'About src/Summary.tsx, line 14:\n> <Row label="Discount" />\n\n',
    );
    expect(askAboutLine({ path: "src/total.ts", side: "old", line: 4 }, "-return a;")).toBe(
      "About src/total.ts, removed line 4:\n> return a;\n\n",
    );
  });
});
