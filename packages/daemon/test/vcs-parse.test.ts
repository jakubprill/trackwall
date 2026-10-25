import { describe, expect, test } from "bun:test";
import { isBinary, parseBlobs, parseLog, parseNulTerminated, parseObjects, parseStatus, parseTree } from "../src/modules/vcs/parse.ts";

describe("parseStatus", () => {
  test("reads the branch, the tracked branch with ahead/behind and counts changes, a rename as one, and untracked files separately", () => {
    const out = [
      "# branch.oid 1111111111111111111111111111111111111111",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaa aaa src/a.ts",
      "2 R. N... 100644 100644 100644 bbb bbb R100 new.ts",
      "old.ts",
      "? new-file.txt",
      "",
    ].join("\0");
    expect(parseStatus(out)).toEqual({
      kind: "ok",
      branch: "main",
      changes: 3,
      untracked: 1,
      upstream: { name: "origin/main", ahead: 2, behind: 3 },
      hasCommits: true,
    });
  });

  test("a detached HEAD without a tracked branch", () => {
    const out = ["# branch.oid 1111111111111111111111111111111111111111", "# branch.head (detached)", ""].join("\0");
    expect(parseStatus(out)).toMatchObject({ branch: null, upstream: null, changes: 0, hasCommits: true });
  });

  test("a repo without commits and a tracked branch that does not exist on the remote", () => {
    const out = ["# branch.oid (initial)", "# branch.head main", "# branch.upstream origin/deleted", ""].join("\0");
    expect(parseStatus(out)).toMatchObject({ branch: "main", upstream: null, hasCommits: false });
  });
});

describe("parseLog", () => {
  test("splits commits on NUL and fields on 0x1f, the subject may contain spaces and colons", () => {
    const out = "abc\x1fAnna\x1f2026-10-23T10:00:00+02:00\x1fAdd: the repo list\0def\x1fJan\x1f2026-10-22T09:00:00+02:00\x1ffix\0";
    expect(parseLog(out)).toEqual([
      { hash: "abc", author: "Anna", date: "2026-10-23T10:00:00+02:00", subject: "Add: the repo list" },
      { hash: "def", author: "Jan", date: "2026-10-22T09:00:00+02:00", subject: "fix" },
    ]);
  });
});

describe("parseTree", () => {
  test("directories before submodules and files, paths with the directory prefix", () => {
    const out = [
      "100644 blob aaa      12\tb.txt",
      "040000 tree bbb       -\tsrc",
      "160000 commit ccc       -\tvendor",
      "100644 blob ddd       5\tA with spaces.md",
      "",
    ].join("\0");
    expect(parseTree(out, "docs")).toEqual([
      { name: "src", path: "docs/src", kind: "dir" },
      { name: "vendor", path: "docs/vendor", kind: "submodule" },
      { name: "A with spaces.md", path: "docs/A with spaces.md", kind: "file", size: 5 },
      { name: "b.txt", path: "docs/b.txt", kind: "file", size: 12 },
    ]);
  });
});

describe("parseObjects", () => {
  test("a line per query; a missing object is undefined, even when the query contains spaces", () => {
    const oid = "a".repeat(40);
    const out = `${oid} tree 0\nHEAD:not here.txt missing\n${oid} blob 12\n`;
    expect(parseObjects(out, 3)).toEqual([{ oid, type: "tree", size: 0 }, undefined, { oid, type: "blob", size: 12 }]);
  });
});

describe("isBinary", () => {
  test("a NUL in the contents means a binary file", () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
    expect(isBinary(Buffer.from("zażółć gęślą jaźń\n"))).toBe(false);
  });
});

describe("parseBlobs", () => {
  test("blob contents in query order; a missing one, another type and a cut end are undefined", () => {
    const oid = "1".repeat(40);
    const out = Buffer.concat([
      Buffer.from(`${oid} blob 3\nabc\n`),
      Buffer.from("HEAD:missing-file missing\n"),
      Buffer.from(`${oid} tree 2\nxy\n`),
      Buffer.from(`${oid} blob 0\n\n`),
      Buffer.from(`${oid} blob 10\ncut o`),
    ]);
    expect(parseBlobs(out, 5).map((b) => b?.toString("utf8"))).toEqual(["abc", undefined, undefined, "", undefined]);
  });
});

describe("parseNulTerminated", () => {
  test("NUL-terminated entries as bytes, and an incomplete last piece of cut output is dropped", () => {
    const out = Buffer.concat([Buffer.from("a.md\0directory/\0"), Buffer.from([0x7a, 0xff, 0]), Buffer.from("cut")]);
    expect(parseNulTerminated(out)).toEqual([Buffer.from("a.md"), Buffer.from("directory/"), Buffer.from([0x7a, 0xff])]);
    expect(parseNulTerminated(Buffer.alloc(0))).toEqual([]);
  });
});
