import {
  CODE_SEARCH_LINE_MAX_CHARS,
  type CodeLine,
  type CodeMatch,
  type CodeQuery,
  type CodeSearchFailure,
  type CodeSearchRepo,
  type SearchCodeResult,
} from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * Code search in many repos of the projects folder (§4.5, ADR-40): `git grep` in each repo's HEAD commit, matches
 * joined in list order and cut to the limit. A repo git cannot search goes to `failed` and does not take away the
 * results of the others.
 */

export interface CodeSearchQuery extends CodeQuery {
  /** Most matches in the result. */
  limit: number;
}

/** A line from `git grep`; `column: null` is a context line. */
interface GrepLine {
  path: string;
  line: number;
  column: number | null;
  text: string;
}

/** What code search needs from `vcs`. */
export interface CodeSearchVcs {
  headCommit(dir: string): Promise<string | null>;
  grep(dir: string, commit: string, query: CodeQuery, maxBytes: number): Promise<{ lines: GrepLine[]; truncated: boolean }>;
}

/**
 * How many repos git searches at once: `git grep` inflates every file of the commit and uses several threads itself,
 * so more processes at once would only split the CPU between them.
 */
const SEARCH_CONCURRENCY = 4;
/** Git output limit per repo: thousands of matches with context, yet bounded memory when the pattern matches everywhere. */
const GREP_MAX_BYTES = 2 * 1024 * 1024;

type RepoOutcome =
  | { kind: "ok"; searched: CodeSearchRepo; matches: CodeMatch[]; truncated: boolean }
  | { kind: "empty" }
  | { kind: "failed"; failure: CodeSearchFailure };

export async function searchCode(entries: readonly RepoEntry[], vcs: CodeSearchVcs, query: CodeSearchQuery): Promise<SearchCodeResult> {
  const outcomes = await mapLimit(entries, SEARCH_CONCURRENCY, (entry) => searchRepo(entry, vcs, query));
  const result: SearchCodeResult = { matches: [], truncated: false, searched: [], failed: [] };
  for (const outcome of outcomes) {
    if (outcome.kind === "failed") result.failed.push(outcome.failure);
    if (outcome.kind !== "ok") continue;
    result.searched.push(outcome.searched);
    result.matches.push(...outcome.matches);
    result.truncated ||= outcome.truncated;
  }
  if (result.matches.length > query.limit) {
    result.matches = result.matches.slice(0, query.limit);
    result.truncated = true;
  }
  return result;
}

async function searchRepo(entry: RepoEntry, vcs: CodeSearchVcs, query: CodeSearchQuery): Promise<RepoOutcome> {
  try {
    const commit = await vcs.headCommit(entry.path);
    if (commit === null) return { kind: "empty" };
    const { lines, truncated } = await vcs.grep(entry.path, commit, query, GREP_MAX_BYTES);
    return { kind: "ok", searched: { repo: entry.id, commit }, matches: withContext(entry.id, lines, query.context), truncated };
  } catch (err) {
    return { kind: "failed", failure: { repo: entry.id, message: messageOf(err) } };
  }
}

/**
 * Matches with their context lines. Git merges overlapping context windows into one group, so lines are looked up by
 * number, not by position in the output; a neighbouring match can be context of another.
 */
function withContext(repo: string, lines: readonly GrepLine[], context: number): CodeMatch[] {
  const byLine = new Map(lines.map((l) => [lineKey(l.path, l.line), l]));
  const around = (path: string, from: number, step: 1 | -1): CodeLine[] => {
    const found: CodeLine[] = [];
    for (let n = from + step; Math.abs(n - from) <= context; n += step) {
      const l = byLine.get(lineKey(path, n));
      if (!l) break;
      found.push({ line: l.line, text: clip(l.text) });
    }
    return step === -1 ? found.reverse() : found;
  };
  return lines.flatMap((l) =>
    l.column === null
      ? []
      : [
          {
            repo,
            path: l.path,
            line: l.line,
            column: l.column,
            text: clip(l.text),
            before: around(l.path, l.line, -1),
            after: around(l.path, l.line, 1),
          },
        ],
  );
}

function lineKey(path: string, line: number): string {
  return `${path}\0${line}`;
}

function clip(text: string): string {
  return text.length > CODE_SEARCH_LINE_MAX_CHARS ? text.slice(0, CODE_SEARCH_LINE_MAX_CHARS) : text;
}
