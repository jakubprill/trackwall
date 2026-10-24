import {
  CODE_SEARCH_LINE_MAX_CHARS,
  CODE_SEARCH_MAX_CHARS,
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
/**
 * After this long no new repo is searched (it goes to `skipped`): an MCP client gives up on a tool call after a
 * minute or two, and a pathological regular expression can keep git busy for its whole time limit in every repo.
 */
const CODE_SEARCH_BUDGET_MS = 60_000;

type RepoOutcome =
  | { kind: "ok"; searched: CodeSearchRepo; matches: CodeMatch[] }
  | { kind: "empty" }
  | { kind: "skipped"; repo: string }
  | { kind: "failed"; failure: CodeSearchFailure };

export async function searchCode(
  entries: readonly RepoEntry[],
  vcs: CodeSearchVcs,
  query: CodeSearchQuery,
  budgetMs = CODE_SEARCH_BUDGET_MS,
): Promise<SearchCodeResult> {
  const deadline = Date.now() + budgetMs;
  // Repos start in list order, so matches of finished repos come before any repo not started yet: once they reach
  // the limit, the rest of the list cannot add a match to the result.
  let found = 0;
  const outcomes = await mapLimit(entries, SEARCH_CONCURRENCY, async (entry): Promise<RepoOutcome> => {
    if (found >= query.limit || Date.now() >= deadline) return { kind: "skipped", repo: entry.id };
    const outcome = await searchRepo(entry, vcs, query);
    if (outcome.kind === "ok") found += outcome.matches.length;
    return outcome;
  });
  return joinOutcomes(outcomes, query.limit);
}

/** Matches of all repos in list order, within `limit` and `CODE_SEARCH_MAX_CHARS`. */
function joinOutcomes(outcomes: readonly RepoOutcome[], limit: number): SearchCodeResult {
  const result: SearchCodeResult = { matches: [], truncated: false, searched: [], failed: [], skipped: [] };
  let chars = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "failed") result.failed.push(outcome.failure);
    if (outcome.kind === "skipped") result.skipped.push(outcome.repo);
    result.truncated ||= outcome.kind === "skipped";
    if (outcome.kind !== "ok") continue;
    const searched = { ...outcome.searched };
    for (const match of outcome.matches) {
      chars += lineChars(match);
      if (result.matches.length >= limit || chars > CODE_SEARCH_MAX_CHARS) {
        searched.truncated = true;
        break;
      }
      result.matches.push(match);
    }
    result.searched.push(searched);
    result.truncated ||= searched.truncated;
  }
  return result;
}

function lineChars(match: CodeMatch): number {
  return [match, ...match.before, ...match.after].reduce((sum, l) => sum + l.text.length, 0);
}

async function searchRepo(entry: RepoEntry, vcs: CodeSearchVcs, query: CodeSearchQuery): Promise<RepoOutcome> {
  try {
    const commit = await vcs.headCommit(entry.path);
    if (commit === null) return { kind: "empty" };
    const { lines, truncated } = await vcs.grep(entry.path, commit, query, GREP_MAX_BYTES);
    // More than `limit` matches of one repo never reach the result, so they are not built at all.
    const matches = withContext(entry.id, lines, query.context, query.limit + 1);
    const cut = matches.length > query.limit;
    return { kind: "ok", searched: { repo: entry.id, commit, truncated: truncated || cut }, matches: matches.slice(0, query.limit) };
  } catch (err) {
    return { kind: "failed", failure: { repo: entry.id, message: messageOf(err) } };
  }
}

/**
 * At most `max` matches with their context lines. Git merges overlapping context windows into one group, so lines
 * are looked up by number, not by position in the output; a neighbouring match can be context of another.
 */
function withContext(repo: string, lines: readonly GrepLine[], context: number, max: number): CodeMatch[] {
  const byLine = new Map(lines.map((l) => [lineKey(l.path, l.line), l]));
  const lineAt = (path: string, n: number): CodeLine[] => {
    const l = byLine.get(lineKey(path, n));
    return l ? [{ line: l.line, text: clip(l.text) }] : [];
  };
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const matches: CodeMatch[] = [];
  for (const l of lines) {
    if (matches.length >= max) break;
    if (l.column === null) continue;
    matches.push({
      repo,
      path: l.path,
      line: l.line,
      column: l.column,
      text: clip(l.text),
      before: range(l.line - context, l.line - 1).flatMap((n) => lineAt(l.path, n)),
      after: range(l.line + 1, l.line + context).flatMap((n) => lineAt(l.path, n)),
    });
  }
  return matches;
}

function lineKey(path: string, line: number): string {
  return `${path}\0${line}`;
}

function clip(text: string): string {
  return text.length > CODE_SEARCH_LINE_MAX_CHARS ? text.slice(0, CODE_SEARCH_LINE_MAX_CHARS) : text;
}
