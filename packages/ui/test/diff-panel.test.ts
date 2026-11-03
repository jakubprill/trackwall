import { describe, expect, test } from "bun:test";
import type { ConversationEntry } from "@trackwall/protocol";
import { conversationTurns } from "../src/lib/conversation.ts";
import { readDiffPanelOpen, saveDiffPanelOpen, shownDiff, turnFiles } from "../src/lib/diff-panel.ts";

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

  test("the panel is closed until the user leaves it open, and a storage that fails reads as closed", () => {
    const stored = new Map<string, string>();
    const storage = () => ({
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });

    expect(readDiffPanelOpen(storage)).toBe(false);
    saveDiffPanelOpen(storage, true);
    expect(readDiffPanelOpen(storage)).toBe(true);
    saveDiffPanelOpen(storage, false);
    expect(readDiffPanelOpen(storage)).toBe(false);
    const broken = () => {
      throw new Error("storage is off");
    };
    expect(readDiffPanelOpen(broken)).toBe(false);
    expect(() => saveDiffPanelOpen(broken, true)).not.toThrow();
  });
});
