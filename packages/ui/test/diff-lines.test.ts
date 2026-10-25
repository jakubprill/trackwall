import { describe, expect, test } from "bun:test";
import { diffLines } from "../src/lib/diff-lines.ts";

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
