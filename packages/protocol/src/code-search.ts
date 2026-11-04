import { z } from "zod";
import { CommitHash, RepoId } from "./workspace.ts";

/**
 * Code search (§4.5, ADR-40): a fixed string or a regular expression in the files of the HEAD commit of many repos at
 * once, through `git grep` over the commit's objects. The query and result contract of the `search_code` MCP tool.
 */

/** Most matches in one result; more would not fit usefully in an agent's context anyway. */
export const CODE_SEARCH_MAX_MATCHES = 500;
/** Most context lines before and after a match. */
export const CODE_SEARCH_MAX_CONTEXT = 10;
/** A match or context line longer than this (minified JS, generated JSON) is cut. */
export const CODE_SEARCH_LINE_MAX_CHARS = 500;
/**
 * Most characters of line text (matches and context), or of paths, in one result: what `search_code`'s text, all an
 * MCP client gets of it (ADR-187), is made from.
 */
export const CODE_SEARCH_MAX_CHARS = 100_000;

/** Text without control characters (below space, and DEL); a tab only where `allowTab`. */
function printable(text: string, allowTab: boolean): boolean {
  return [...text].every((c) => (c >= " " && c !== "\x7f") || (allowTab && c === "\t"));
}

/** A git pathspec: `*.java` (in any directory), `src/`, `:!*.test.ts` (exclusion); no control characters. */
export const CodePathspec = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => printable(p, false), "pathspec: no control characters");

/** Most pathspecs in one query (`search_code`, `get_task_changes`). */
export const CODE_PATHSPECS_MAX = 20;
export const CodePathspecs = z.array(CodePathspec).max(CODE_PATHSPECS_MAX);

/** What to search for and where in one repo; the `search_code` tool adds the choice of repos and the match limit. */
export const CodeQuery = z.object({
  /** One line: git would split a pattern with a newline into several, and one of them may match every line. */
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine((p) => printable(p, true), "pattern: one line, no control characters except tab"),
  /** A POSIX extended regular expression (`git grep -E`) instead of a fixed string. */
  regex: z.boolean(),
  ignoreCase: z.boolean(),
  /** An empty list means the whole commit tree. */
  paths: CodePathspecs,
  /** Context lines before and after a match. */
  context: z.number().int().min(0).max(CODE_SEARCH_MAX_CONTEXT),
});
export type CodeQuery = z.infer<typeof CodeQuery>;

/** A file line: its number from 1 and its text, cut to `CODE_SEARCH_LINE_MAX_CHARS`. */
export const CodeLine = z.object({
  line: z.number().int().positive(),
  text: z.string(),
});
export type CodeLine = z.infer<typeof CodeLine>;

export const CodeMatch = z.object({
  repo: RepoId,
  /** Path in the commit tree, with `/`. */
  path: z.string(),
  line: z.number().int().positive(),
  /** Column of the first match in the line, from 1, in bytes (as git counts it). */
  column: z.number().int().positive(),
  text: z.string(),
  /** Lines before the match (the nearest one last); they may be matches themselves. */
  before: z.array(CodeLine),
  after: z.array(CodeLine),
});
export type CodeMatch = z.infer<typeof CodeMatch>;

/** A repo git could not search (e.g. an invalid regular expression, git's time limit); the other repos still have results. */
export const CodeSearchFailure = z.object({
  repo: RepoId,
  message: z.string(),
});
export type CodeSearchFailure = z.infer<typeof CodeSearchFailure>;

/**
 * What a code search returns: every match line with its context (`lines`), or only the files with matches and how
 * many lines match in each (`files`), a much shorter first look from which the agent picks the files to read (ADR-187).
 */
export const CodeSearchOutput = z.enum(["lines", "files"]);
export type CodeSearchOutput = z.infer<typeof CodeSearchOutput>;

/** A file with matches, in `files` output: how many of its lines match. */
export const CodeFile = z.object({
  repo: RepoId,
  /** Path in the commit tree, with `/`. */
  path: z.string(),
  matches: z.number().int().positive(),
});
export type CodeFile = z.infer<typeof CodeFile>;

export const CodeSearchRepo = z.object({
  repo: RepoId,
  /** The commit searched; a repo without commits is not listed. */
  commit: CommitHash,
  /** Not every match of this repo is in the result (the limit, or git's output was cut, e.g. by a huge minified line). */
  truncated: z.boolean(),
});
export type CodeSearchRepo = z.infer<typeof CodeSearchRepo>;

export const SearchCodeResult = z.object({
  /** Matches in the order of the repo list, then by path and line; empty in `files` output. */
  matches: z.array(CodeMatch),
  /** In `files` output, the files with matches in the order of the repo list, then by path; empty in `lines` output. */
  files: z.array(CodeFile),
  /**
   * Not every match (or file) may be in the result: more than the limit or `CODE_SEARCH_MAX_CHARS`, a repo's git output was
   * cut, or some repos were skipped; narrow the query.
   */
  truncated: z.boolean(),
  /** The repos searched, with the commit searched in each. */
  searched: z.array(CodeSearchRepo),
  failed: z.array(CodeSearchFailure),
  /** Repos not searched because the limit was already reached or the search ran out of time (`truncated` is then true). */
  skipped: z.array(RepoId),
});
export type SearchCodeResult = z.infer<typeof SearchCodeResult>;
