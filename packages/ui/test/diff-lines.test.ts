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
        { offset: 0, text: "+a", kind: "added" },
        { offset: 3, text: "-b", kind: "removed" },
      ],
      more: true,
    });
    expect(diffLines("+a\n", 2).more).toBe(false);
  });
});
