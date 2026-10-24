import { describe, expect, test } from "bun:test";
import { diffLines } from "../src/lib/diff-lines.ts";

const kinds = (patch: string[]) => diffLines(patch.join("\n"), 100).lines.map((l) => l.kind);

describe("linie diffu zadania", () => {
  test("nagłówki pliku nie są dodanymi ani usuniętymi liniami", () => {
    expect(
      kinds(["diff --git a/x.ts b/x.ts", "index 1..2 100644", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-stara", "+nowa", " bez zmian"]),
    ).toEqual(["file", "meta", "meta", "meta", "hunk", "removed", "added", "context"]);
  });

  test("w treści zmiany linia zaczynająca się od --- albo +++ jest usunięta albo dodana, a nie nagłówkiem", () => {
    expect(kinds(["diff --git a/x.sql b/x.sql", "--- a/x.sql", "+++ b/x.sql", "@@ -1 +1 @@", "--- komentarz SQL", "+++ licznik"])).toEqual([
      "file",
      "meta",
      "meta",
      "hunk",
      "removed",
      "added",
    ]);
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
