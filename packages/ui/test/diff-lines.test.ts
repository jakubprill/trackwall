import { describe, expect, test } from "bun:test";
import { changeLines, diffLines } from "../src/lib/diff-lines.ts";

const kinds = (patch: string[]) => diffLines(patch.join("\n"), 100).lines.map((l) => l.kind);

describe("task diff lines", () => {
  test("file headers are neither added nor removed lines", () => {
    expect(
      kinds(["diff --git a/x.ts b/x.ts", "index 1..2 100644", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new", " unchanged"]),
    ).toEqual(["file", "meta", "meta", "meta", "hunk", "removed", "added", "context"]);
  });

  test("inside a change a line starting with --- or +++ is removed or added, not a header", () => {
    expect(kinds(["diff --git a/x.sql b/x.sql", "--- a/x.sql", "+++ b/x.sql", "@@ -1 +1 @@", "--- SQL comment", "+++ counter"])).toEqual([
      "file",
      "meta",
      "meta",
      "hunk",
      "removed",
      "added",
    ]);
  });

  test("a diff longer than the line limit gives the start and a marker that there is more", () => {
    expect(diffLines("+a\n-b\n c\n", 2)).toEqual({
      lines: [
        { offset: 0, text: "+a", kind: "added", anchor: null },
        { offset: 3, text: "-b", kind: "removed", anchor: null },
      ],
      more: true,
    });
    expect(diffLines("+a\n", 2).more).toBe(false);
  });

  test("a line of a change knows its file and line: added and unchanged ones in the worktree, removed ones in the base commit", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,3 @@ function a()",
      " keep",
      "-old",
      "+new",
      " end",
      "\\ No newline at end of file",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ];
    expect(
      diffLines(patch.join("\n"), 100).lines.flatMap((l) =>
        l.anchor ? [`${l.text} ${l.anchor.path}:${l.anchor.side}:${l.anchor.line}`] : [],
      ),
    ).toEqual([" keep src/a.ts:new:10", "-old src/a.ts:old:11", "+new src/a.ts:new:11", " end src/a.ts:new:12", "-bye gone.ts:old:1"]);
  });

  test("a quoted file name with escapes and octal UTF-8 bytes is read back to the path", () => {
    const patch = [
      'diff --git "a/x \\"q\\".ts" "b/x \\"q\\".ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251 \\"q\\".ts"',
      "@@ -0,0 +1 @@",
      "+hi",
    ];
    expect(diffLines(patch.join("\n"), 100).lines.at(-1)?.anchor).toEqual({ path: 'café "q".ts', side: "new", line: 1 });
  });

  test("a file name with a space loses the tab git ends it with", () => {
    const patch = ["diff --git a/my file.ts b/my file.ts", "--- a/my file.ts\t", "+++ b/my file.ts\t", "@@ -1 +1 @@", "-a", "+b"];
    expect(diffLines(patch.join("\n"), 100).lines.at(-1)?.anchor).toEqual({ path: "my file.ts", side: "new", line: 1 });
  });
});

describe("a tool call's change", () => {
  test("shows the hunks without the file header and counts the added and removed lines", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\nindex 0000000..0000000 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n";
    const change = changeLines(patch, 10);

    expect(change.lines.map((line) => [line.kind, line.text])).toEqual([
      ["hunk", "@@ -1,2 +1,3 @@"],
      ["context", " one"],
      ["removed", "-two"],
      ["added", "+TWO"],
      ["added", "+three"],
    ]);
    expect([change.added, change.removed, change.more]).toEqual([2, 1, false]);
  });

  test("a patch that starts with --- has its file names out of the lines too", () => {
    const change = changeLines("--- a/dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n", 10);

    expect(change.lines.map((line) => line.text)).toEqual(["@@ -0,0 +1,1 @@", "+hello"]);
    expect([change.added, change.removed]).toEqual([1, 0]);
  });

  test("beyond the line limit it gives the start, but counts every line, and says there is more", () => {
    const change = changeLines(`--- a/f\n+++ b/f\n@@ -0,0 +1,5 @@\n${"+x\n".repeat(5)}`, 3);

    expect(change.lines).toHaveLength(3);
    expect([change.added, change.more]).toEqual([5, true]);
  });

  test("no patch is no change", () => {
    expect(changeLines("", 10)).toEqual({ lines: [], added: 0, removed: 0, more: false });
  });
});
