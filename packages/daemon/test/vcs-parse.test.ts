import { describe, expect, test } from "bun:test";
import { isBinary, parseBlobs, parseLog, parseNulTerminated, parseObjects, parseStatus, parseTree } from "../src/modules/vcs/parse.ts";

describe("parseStatus", () => {
  test("czyta gałąź, gałąź śledzoną z ahead/behind i liczy zmiany, także zmianę nazwy jako jedną", () => {
    const out = [
      "# branch.oid 1111111111111111111111111111111111111111",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaa aaa src/a.ts",
      "2 R. N... 100644 100644 100644 bbb bbb R100 nowa.ts",
      "stara.ts",
      "? nowy-plik.txt",
      "",
    ].join("\0");
    expect(parseStatus(out)).toEqual({
      kind: "ok",
      branch: "main",
      changes: 3,
      upstream: { name: "origin/main", ahead: 2, behind: 3 },
      hasCommits: true,
    });
  });

  test("odłączony HEAD bez gałęzi śledzonej", () => {
    const out = ["# branch.oid 1111111111111111111111111111111111111111", "# branch.head (detached)", ""].join("\0");
    expect(parseStatus(out)).toMatchObject({ branch: null, upstream: null, changes: 0, hasCommits: true });
  });

  test("repo bez commitów i gałąź śledzona, której nie ma na zdalnym", () => {
    const out = ["# branch.oid (initial)", "# branch.head main", "# branch.upstream origin/usunieta", ""].join("\0");
    expect(parseStatus(out)).toMatchObject({ branch: "main", upstream: null, hasCommits: false });
  });
});

describe("parseLog", () => {
  test("rozdziela commity po NUL i pola po 0x1f, temat może zawierać spacje i dwukropki", () => {
    const out = "abc\x1fAnna\x1f2026-10-23T10:00:00+02:00\x1fDodaj: listę repo\0def\x1fJan\x1f2026-10-22T09:00:00+02:00\x1fpoprawka\0";
    expect(parseLog(out)).toEqual([
      { hash: "abc", author: "Anna", date: "2026-10-23T10:00:00+02:00", subject: "Dodaj: listę repo" },
      { hash: "def", author: "Jan", date: "2026-10-22T09:00:00+02:00", subject: "poprawka" },
    ]);
  });
});

describe("parseTree", () => {
  test("katalogi przed submodułami i plikami, ścieżki z prefiksem katalogu", () => {
    const out = [
      "100644 blob aaa      12\tb.txt",
      "040000 tree bbb       -\tsrc",
      "160000 commit ccc       -\tvendor",
      "100644 blob ddd       5\tA z spacją.md",
      "",
    ].join("\0");
    expect(parseTree(out, "docs")).toEqual([
      { name: "src", path: "docs/src", kind: "dir" },
      { name: "vendor", path: "docs/vendor", kind: "submodule" },
      { name: "A z spacją.md", path: "docs/A z spacją.md", kind: "file", size: 5 },
      { name: "b.txt", path: "docs/b.txt", kind: "file", size: 12 },
    ]);
  });
});

describe("parseObjects", () => {
  test("linia na zapytanie; brakujący obiekt to undefined, nawet gdy zapytanie zawiera spacje", () => {
    const oid = "a".repeat(40);
    const out = `${oid} tree 0\nHEAD:nie ma.txt missing\n${oid} blob 12\n`;
    expect(parseObjects(out, 3)).toEqual([{ oid, type: "tree", size: 0 }, undefined, { oid, type: "blob", size: 12 }]);
  });
});

describe("isBinary", () => {
  test("NUL w treści znaczy plik binarny", () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
    expect(isBinary(Buffer.from("zażółć gęślą jaźń\n"))).toBe(false);
  });
});

describe("parseBlobs", () => {
  test("treść blobów w kolejności zapytań; brakujący, inny typ i ucięty koniec to undefined", () => {
    const oid = "1".repeat(40);
    const out = Buffer.concat([
      Buffer.from(`${oid} blob 3\nabc\n`),
      Buffer.from("HEAD:nie-ma missing\n"),
      Buffer.from(`${oid} tree 2\nxy\n`),
      Buffer.from(`${oid} blob 0\n\n`),
      Buffer.from(`${oid} blob 10\nucięt`),
    ]);
    expect(parseBlobs(out, 5).map((b) => b?.toString("utf8"))).toEqual(["abc", undefined, undefined, "", undefined]);
  });
});

describe("parseNulTerminated", () => {
  test("wpisy zakończone NUL jako bajty, a niepełny ostatni kawałek uciętego wyjścia odpada", () => {
    const out = Buffer.concat([Buffer.from("a.md\0katalog/\0"), Buffer.from([0x7a, 0xff, 0]), Buffer.from("uci")]);
    expect(parseNulTerminated(out)).toEqual([Buffer.from("a.md"), Buffer.from("katalog/"), Buffer.from([0x7a, 0xff])]);
    expect(parseNulTerminated(Buffer.alloc(0))).toEqual([]);
  });
});
