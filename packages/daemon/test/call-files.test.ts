import { describe, expect, test } from "bun:test";
import { CallReads, readCallFiles } from "../src/modules/cards/call-files.ts";
import { CALL_SOURCES, CARD_DOCUMENTS, CARD_SOURCES } from "../src/modules/cards/extract-card.ts";
import { type CallSelection, readSnapshot, type SnapshotVcs } from "../src/modules/cards/read-snapshot.ts";
import { loadSyntaxParsers, type SyntaxParsers } from "../src/modules/cards/syntax-tree.ts";

const parsers = await loadSyntaxParsers();
const SERVICE = "package a;\npublic class Service { public int run() { return 1; } }";

/** Parsers that count the files they parse. */
function counting(): { parsers: SyntaxParsers; parsed: string[] } {
  const parsed: string[] = [];
  return {
    parsed,
    parsers: {
      read(language, text, read) {
        parsed.push(text);
        return parsers.read(language, text, read);
      },
    },
  };
}

describe("reading call files for the endpoint reach (ADR-82)", () => {
  test("a file is parsed once per blob id: the next commit with the same content takes the kept read", async () => {
    const reads = new CallReads();
    const first = counting();
    const one = await readCallFiles([{ path: "src/main/java/a/Service.java", oid: "b1", text: SERVICE }], first.parsers, reads);
    expect(one.files?.map((f) => [f.path, f.calls.types.map((t) => t.name)])).toEqual([["src/main/java/a/Service.java", ["Service"]]]);
    const kept = reads.get("b1");
    if (kept === undefined) throw new Error("the read of b1 was not kept");

    const second = counting();
    // The same blob under another path (a copied service): the commit read takes the kept read, so no text and no parse.
    const two = await readCallFiles([{ path: "copy/src/main/java/a/Service.java", oid: "b1", calls: kept }], second.parsers, reads);
    expect(second.parsed).toEqual([]);
    expect(two.files?.map((f) => f.path)).toEqual(["copy/src/main/java/a/Service.java"]);
    expect(two.files?.[0]?.calls).toBe(one.files?.[0]?.calls);
    expect(two.complete).toBe(true);
  });

  test("a repo with Kotlin code is not traced, and that holds for the commit", async () => {
    const read = await readCallFiles(
      [
        { path: "src/main/java/a/Service.java", oid: "b1", text: SERVICE },
        { path: "src/main/kotlin/a/Client.kt", oid: "b2", text: "class Client" },
      ],
      counting().parsers,
      new CallReads(),
    );
    expect(read).toEqual({ files: null, problems: [], complete: true });
  });

  test("a file that took too long to parse leaves the card without a reach, and the card is computed again later", async () => {
    const slow: SyntaxParsers = { read: () => ({ kind: "timeout" }) };
    const read = await readCallFiles([{ path: "src/main/java/a/Service.java", oid: "b1", text: SERVICE }], slow, new CallReads());
    expect(read).toEqual({
      files: null,
      problems: [
        {
          code: "parse-incomplete",
          path: "src/main/java/a/Service.java",
          message: "parsing the file took too long; endpoints have no reach",
        },
      ],
      complete: false,
    });
  });

  test("a commit read fetches every source file whose blob is not kept, and the extractors do not see them", async () => {
    const files = [
      { path: "src/main/java/a/Api.java", size: 10, oid: "api" },
      { path: "src/main/java/a/Service.java", size: 10, oid: "service" },
      { path: "src/main/java/a/Kept.java", size: 10, oid: "kept" },
    ];
    const fetched: string[][] = [];
    const vcs: SnapshotVcs = {
      commitFiles: async () => ({ files, truncated: false }),
      readFiles: async (_dir, _commit, paths) => {
        fetched.push([...paths]);
        return new Map(paths.map((p) => [p, Buffer.from(`// ${p}`)]));
      },
      // Only the controller has an annotation the search finds.
      grepFiles: async () => ({ paths: ["src/main/java/a/Api.java"], truncated: false }),
    };
    const keptRead = { pkg: "a", imports: new Map(), wildcards: [], types: [] };
    const calls: CallSelection = { accepts: CALL_SOURCES, kept: (oid) => (oid === "kept" ? keptRead : undefined) };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), () => false, CARD_SOURCES, calls, CARD_DOCUMENTS);

    expect(fetched).toEqual([["src/main/java/a/Api.java"], ["src/main/java/a/Service.java"]]);
    expect(snapshot.callSources).toEqual([
      { path: "src/main/java/a/Api.java", oid: "api", text: "// src/main/java/a/Api.java" },
      { path: "src/main/java/a/Service.java", oid: "service", text: "// src/main/java/a/Service.java" },
      { path: "src/main/java/a/Kept.java", oid: "kept", calls: keptRead },
    ]);
    // A file read only for the reach does not change the card's HTTP facts.
    expect(snapshot.text("src/main/java/a/Service.java")).toBeUndefined();
    expect(snapshot.text("src/main/java/a/Api.java")).toBe("// src/main/java/a/Api.java");
  });

  test("a source file over the size limit leaves the commit without call sources, with a problem", async () => {
    const vcs: SnapshotVcs = {
      commitFiles: async () => ({ files: [{ path: "src/main/java/a/Huge.java", size: 2 * 1024 * 1024, oid: "huge" }], truncated: false }),
      readFiles: async () => new Map(),
      grepFiles: async () => ({ paths: [], truncated: false }),
    };
    const calls: CallSelection = { accepts: CALL_SOURCES, kept: () => undefined };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), () => false, CARD_SOURCES, calls, CARD_DOCUMENTS);
    expect(snapshot.callSources).toBeNull();
    expect(snapshot.problems).toEqual([
      {
        code: "files-not-read",
        path: "src/main/java/a/Huge.java",
        message: "1 source files are larger than 1048576 B; endpoints have no reach",
      },
    ]);
  });

  test("source files kept from earlier cards still count against the read limit, so the result depends only on the commit", async () => {
    const files = Array.from({ length: 70 }, (_, i) => ({ path: `src/main/java/a/F${i}.java`, size: 1_000_000, oid: `f${i}` }));
    const vcs: SnapshotVcs = {
      commitFiles: async () => ({ files, truncated: false }),
      readFiles: async () => new Map(),
      grepFiles: async () => ({ paths: [], truncated: false }),
    };
    const everyReadKept: CallSelection = {
      accepts: CALL_SOURCES,
      kept: () => ({ pkg: "a", imports: new Map(), wildcards: [], types: [] }),
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), () => false, CARD_SOURCES, everyReadKept, CARD_DOCUMENTS);
    expect(snapshot.callSources).toBeNull();
    expect(snapshot.problems).toEqual([
      {
        code: "files-not-read",
        path: "",
        message: "70 source files do not fit within the 67108864 B commit read limit; endpoints have no reach",
      },
    ]);
  });
});
