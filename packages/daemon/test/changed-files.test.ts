import { describe, expect, test } from "bun:test";
import { parseChangedFiles } from "../src/modules/vcs/parse.ts";

describe("zmienione pliki z git diff", () => {
  test("rodzaj zmiany z --name-status i liczby linii z --numstat, z null dla pliku binarnego", () => {
    const nameStatus = "A\0nowy plik.ts\0M\0src/a.ts\0D\0stary.png\0";
    const numstat = "3\t0\tnowy plik.ts\0" + "2\t5\tsrc/a.ts\0" + "-\t-\tstary.png\0";
    expect(parseChangedFiles(nameStatus, numstat)).toEqual([
      { path: "nowy plik.ts", change: "added", additions: 3, deletions: 0 },
      { path: "src/a.ts", change: "modified", additions: 2, deletions: 5 },
      { path: "stary.png", change: "deleted", additions: null, deletions: null },
    ]);
  });
});
