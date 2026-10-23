import { describe, expect, test } from "bun:test";
import { diffLineKind, diffLines } from "../src/lib/diff-lines.ts";

describe("linie diffu zadania", () => {
  test("nagłówki pliku nie są dodanymi ani usuniętymi liniami", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-stara",
      "+nowa",
      " bez zmian",
    ];
    expect(patch.map(diffLineKind)).toEqual(["file", "meta", "meta", "meta", "hunk", "removed", "added", "context"]);
  });

  test("diff dłuższy niż limit linii daje początek i znacznik, że jest więcej", () => {
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
