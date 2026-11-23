import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { blobId, keepMessage, keptFiles, STORE_README, storeFolderChanges } from "../src/modules/local-config/store-folders.ts";

const NOTE = Buffer.from("Integration tests run with mise run test-it.\n");
const NOTE_ID = execFileSync("git", ["hash-object", "--stdin"], { input: NOTE }).toString("utf8").trim();
const README = Buffer.from("# Workspace store\n");
const NOTHING = { copies: [], held: [] };

describe("the workspace's folders in the workspace store", () => {
  test("a blob id is git's own, so a file the store has unchanged is recognised without reading it from git", () => {
    expect(blobId(NOTE, NOTE_ID)).toBe(NOTE_ID);
    expect(blobId(NOTE, "0".repeat(64))).toHaveLength(64);
  });

  test("only the store's front page and the files right in its four folders are the daemon's to keep", () => {
    const listed = [
      { path: "repos/orders/mise.local.toml", oid: "a" },
      { path: "knowledge/flaky-tests.md", oid: "b" },
      { path: "board/sub/item.md", oid: "c" },
      { path: "notes/todo.md", oid: "d" },
      { path: "README.md", oid: "e" },
    ];

    expect(keptFiles(listed)).toEqual(
      new Map([
        ["knowledge/flaky-tests.md", "b"],
        ["README.md", "e"],
      ]),
    );
  });

  test("a new file goes in with the front page, an unchanged one is left, and one gone from its folder comes out", () => {
    const kept = new Map([
      ["knowledge/test-it.md", NOTE_ID],
      ["knowledge/old.md", "f".repeat(40)],
    ]);
    const wanted = new Map([
      ["knowledge" as const, { copies: [{ file: "test-it.md", bytes: NOTE }], held: [] }],
      ["board" as const, { copies: [{ file: "1.md", bytes: NOTE }], held: [] }],
    ]);

    expect(storeFolderChanges(kept, wanted, README)).toEqual({
      files: [
        { path: "board/1.md", content: NOTE },
        { path: STORE_README, content: README },
      ],
      removed: ["knowledge/old.md"],
      folders: ["knowledge", "board"],
    });
  });

  test("a held file keeps the store's version and a folder that was not read keeps all of its files", () => {
    const kept = new Map([
      ["routines/check-docs.md", "a".repeat(40)],
      ["board/1.md", "b".repeat(40)],
    ]);
    const wanted = new Map([["routines" as const, { copies: [], held: ["check-docs.md"] }]]);

    expect(storeFolderChanges(kept, wanted, README)).toEqual({ files: [], removed: [], folders: [] });
  });

  test("with every folder empty the folders come out and the front page stays", () => {
    const kept = new Map([
      ["knowledge/test-it.md", NOTE_ID],
      [STORE_README, "e".repeat(40)],
    ]);
    const wanted = new Map([
      ["knowledge" as const, NOTHING],
      ["routines" as const, NOTHING],
    ]);

    const changes = storeFolderChanges(kept, wanted, null);

    expect(changes).toEqual({ files: [], removed: ["knowledge/test-it.md"], folders: ["knowledge"] });
    expect(keepMessage(changes, false)).toBe("Stop keeping knowledge");
  });

  test("the front page is not written again over the one the store has", () => {
    const kept = new Map([[STORE_README, "e".repeat(40)]]);
    const wanted = new Map([["task-templates" as const, { copies: [{ file: "fix-a-bug.md", bytes: NOTE }], held: [] }]]);

    const changes = storeFolderChanges(kept, wanted, README);

    expect(changes.files.map((f) => f.path)).toEqual(["task-templates/fix-a-bug.md"]);
    expect(keepMessage(changes, true)).toBe("Keep task-templates");
  });
});
