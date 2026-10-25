import { describe, expect, test } from "bun:test";
import { parseChangedFiles } from "../src/modules/vcs/parse.ts";

describe("changed files from git diff", () => {
  test("the change kind from --name-status and line counts from --numstat, with null for a binary file", () => {
    const nameStatus = "A\0new file.ts\0M\0src/a.ts\0D\0old.png\0";
    const numstat = "3\t0\tnew file.ts\0" + "2\t5\tsrc/a.ts\0" + "-\t-\told.png\0";
    expect(parseChangedFiles(nameStatus, numstat)).toEqual([
      { path: "new file.ts", change: "added", additions: 3, deletions: 0 },
      { path: "src/a.ts", change: "modified", additions: 2, deletions: 5 },
      { path: "old.png", change: "deleted", additions: null, deletions: null },
    ]);
  });
});
