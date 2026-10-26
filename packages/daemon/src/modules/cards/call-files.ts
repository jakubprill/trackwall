import type { CardProblem } from "@trackwall/protocol";
import type { CallFile } from "./call-types.ts";
import { type JavaCalls, readJavaCalls } from "./java-calls.ts";
import type { CallSource } from "./snapshot.ts";
import { jvmLanguageOf } from "./spring.ts";
import type { SyntaxParsers } from "./syntax-tree.ts";

/**
 * Reading the source files for the endpoint reach (§4.6, ADR-82): every Java file of the commit through tree-sitter,
 * with what was read kept by blob id (`CallReads`), so a new commit parses only the files it changed. Parsing a large
 * repo takes seconds and runs on the daemon's thread, so the read gives way to other work every `SLICE_MS` and stops
 * after `CALL_PARSE_BUDGET_MS`; what it parsed stays kept for the next computation of a card.
 */

/**
 * The total parse time of one card's source files: a repo of 5,500 Java files took about 7 s on a fast computer, and the
 * read gives way to other work meanwhile, so the limit only guards against a repo far larger than that.
 */
const CALL_PARSE_BUDGET_MS = 60_000;
/** How long the read parses before giving way to the event loop: API requests wait at most this long. */
const SLICE_MS = 50;
/** Reads kept across all repos: a few large repos; each holds a file's types, methods and calls, not its text. */
const MAX_KEPT_READS = 50_000;

/** What `java-calls.ts` read from a file, by blob id; the oldest are dropped past `MAX_KEPT_READS`. */
export class CallReads {
  private readonly reads = new Map<string, JavaCalls>();

  get(oid: string): JavaCalls | undefined {
    const read = this.reads.get(oid);
    if (read !== undefined) {
      // Most recently used last, so the oldest is the first to go.
      this.reads.delete(oid);
      this.reads.set(oid, read);
    }
    return read;
  }

  set(oid: string, read: JavaCalls): void {
    this.reads.set(oid, read);
    for (const oldest of this.reads.keys()) {
      if (this.reads.size <= MAX_KEPT_READS) break;
      this.reads.delete(oldest);
    }
  }
}

/**
 * The card's call files: `files` is `null` when the reach cannot be computed (the repo has Kotlin code, a file was not
 * read, parsed or parsed in time); `complete` is `false` when that depends on the moment (time, parsers), not on the commit.
 */
export interface CallFiles {
  files: CallFile[] | null;
  problems: CardProblem[];
  complete: boolean;
}

export async function readCallFiles(sources: readonly CallSource[] | null, parsers: SyntaxParsers, reads: CallReads): Promise<CallFiles> {
  // Kotlin is not read yet: a path through Kotlin code would be missing, so no reach rather than a wrong one.
  if (sources === null || sources.some((s) => jvmLanguageOf(s.path) === "kotlin")) return { files: null, problems: [], complete: true };
  const started = performance.now();
  let slice = started;
  const files: CallFile[] = [];
  for (const source of sources) {
    if (performance.now() - slice > SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      slice = performance.now();
    }
    if (performance.now() - started > CALL_PARSE_BUDGET_MS) return overBudget(sources.length - files.length);
    const read = readOne(source, parsers, reads);
    if (read.kind !== "read") return read.result;
    files.push({ path: source.path, calls: read.calls });
  }
  return { files, problems: [], complete: true };
}

type OneRead = { kind: "read"; calls: JavaCalls } | { kind: "failed"; result: CallFiles };

function readOne(source: CallSource, parsers: SyntaxParsers, reads: CallReads): OneRead {
  if ("calls" in source) return { kind: "read", calls: source.calls };
  const parsed = parsers.read("java", source.text, readJavaCalls);
  switch (parsed.kind) {
    case "parsed":
      reads.set(source.oid, parsed.value);
      return { kind: "read", calls: parsed.value };
    case "timeout":
      return failed(source.path, "parsing the file took too long");
    case "over-budget":
      return failed(source.path, "the card's parse time was used up");
    case "unavailable":
      return failed(source.path, `no Java parser: ${parsed.reason}`);
  }
}

/** A file without a read: the reasons all depend on the moment, so the card is computed again next time. */
function failed(path: string, reason: string): OneRead {
  const problem: CardProblem = { code: "parse-incomplete", path, message: `${reason}; endpoints have no reach` };
  return { kind: "failed", result: { files: null, problems: [problem], complete: false } };
}

function overBudget(left: number): CallFiles {
  const message = `${left} source files were not parsed within ${CALL_PARSE_BUDGET_MS} ms; endpoints have no reach until the daemon computes the card again after a restart`;
  return { files: null, problems: [{ code: "parse-incomplete", path: "", message }], complete: false };
}
