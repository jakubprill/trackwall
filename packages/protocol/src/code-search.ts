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
 * Most characters of line text (matches and context) in one result; the result goes to the agent twice (text and
 * `structuredContent`), as with the README in `get_repo`.
 */
export const CODE_SEARCH_MAX_CHARS = 100_000;

/** A git pathspec: `*.java` (in any directory), `src/`, `:!*.test.ts` (exclusion); no control characters. */
export const CodePathspec = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => [...p].every((c) => c >= " "), "pathspec: no control characters");

/** What to search for and where in one repo; the `search_code` tool adds the choice of repos and the match limit. */
export const CodeQuery = z.object({
  /** One line: git would split a pattern with a newline into several, and one of them may match every line. */
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine((p) => [...p].every((c) => c >= " " || c === "\t"), "pattern: one line, no control characters"),
  /** A POSIX extended regular expression (`git grep -E`) instead of a fixed string. */
  regex: z.boolean(),
  ignoreCase: z.boolean(),
  /** An empty list means the whole commit tree. */
  paths: z.array(CodePathspec).max(20),
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

/**
 * A repo that could not be searched (git refused, e.g. an invalid regular expression, or time ran out); the other
 * repos still have results.
 */
export const CodeSearchFailure = z.object({
  repo: RepoId,
  message: z.string(),
});
export type CodeSearchFailure = z.infer<typeof CodeSearchFailure>;

export const CodeSearchRepo = z.object({
  repo: RepoId,
  /** The commit searched; a repo without commits is not listed. */
  commit: CommitHash,
  /** Not every match of this repo is in the result (the limit, or git's output was cut, e.g. by a huge minified line). */
  truncated: z.boolean(),
});
export type CodeSearchRepo = z.infer<typeof CodeSearchRepo>;

export const SearchCodeResult = z.object({
  /** Matches in the order of the repo list, then by path and line. */
  matches: z.array(CodeMatch),
  /**
   * Not every match is in the result: more than the limit or `CODE_SEARCH_MAX_CHARS`, a repo's git output was cut, or
   * repos were not searched because the limit was already reached; narrow the query.
   */
  truncated: z.boolean(),
  /** The repos searched, with the commit searched in each. */
  searched: z.array(CodeSearchRepo),
  failed: z.array(CodeSearchFailure),
});
export type SearchCodeResult = z.infer<typeof SearchCodeResult>;
