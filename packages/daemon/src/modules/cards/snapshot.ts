import type {
  BuildFile,
  CardProblem,
  Consumed,
  ConsumedPackage,
  Evidence,
  Provided,
  ProvidedPackage,
  ToolRequirement,
} from "@trackwall/protocol";

/**
 * A commit as the extractors see it: the file list and the content of build and configuration files, read from git in
 * one process before extraction (`read-snapshot.ts`). The extractors are pure functions on this object, so they are
 * tested without git. Paths as in `repo-path.ts`.
 */
export interface RepoSnapshot {
  commit: string;
  /** The commit's files outside dependency directories (`SKIPPED_DIRS` in `read-snapshot.ts`). */
  paths: readonly string[];
  /** `true` when git's file list was cut at its limit, so `paths` is only its beginning and an absent file may exist. */
  pathsTruncated: boolean;
  /** The file's content; `undefined` when it does not exist or was not read (it is neither a build nor a configuration file). */
  text(path: string): string | undefined;
  /**
   * Source files fetched only for endpoint contracts (ADR-38), by type names: the contracts read DTOs from them, but the
   * HTTP extractors do not see them, so the HTTP facts depend only on the files from the search.
   */
  typeFiles: ReadonlySet<string>;
  /** What reading the commit could not read (limits); it goes on the card together with the extractors' problems. */
  problems: readonly CardProblem[];
}

/** What an extractor adds to the card; build extractors give packages, HTTP extractors apps, endpoints and clients. */
export interface Extracted<P extends Provided = ProvidedPackage, C extends Consumed = ConsumedPackage> {
  buildFiles: BuildFile[];
  provides: P[];
  consumes: C[];
  tools: ToolRequirement[];
  problems: CardProblem[];
}

/** A place for card problems for a read that gives no other facts (the version catalog, Spring configuration). */
export type ProblemSink = Pick<Extracted, "problems">;

export function emptyExtracted<P extends Provided = ProvidedPackage, C extends Consumed = ConsumedPackage>(): Extracted<P, C> {
  return { buildFiles: [], provides: [], consumes: [], tools: [], problems: [] };
}

/** Evidence: the file and the first line matching `pattern` (`null` when none matches). */
export function evidenceAt(path: string, text: string, pattern: RegExp): Evidence {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  return { path, line: index < 0 ? null : index + 1 };
}

/**
 * The line (from 1) of the first occurrence of every key the expression `key` (with the `g` flag) captures in its first
 * matching group (alternatives for a quoted and an unquoted key). One pass over the file instead of a separate search
 * for every dependency: a file with tens of thousands of keys would take quadratic time, and the file is untrusted (§8).
 */
export function keyLines(text: string, key: RegExp): Map<string, number> {
  const lines = new Map<string, number>();
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(key)) {
      const name = m.slice(1).find((group) => group !== undefined);
      if (name !== undefined && !lines.has(name)) lines.set(name, i + 1);
    }
  });
  return lines;
}
