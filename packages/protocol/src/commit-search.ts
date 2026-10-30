import { z } from "zod";
import { CodePathspecs, CodeQuery } from "./code-search.ts";
import { CommitHash, RepoId } from "./workspace.ts";

/**
 * Commit search (§4.5, ADR-149): the history of the HEAD commit of many repos at once, through `git log` with the
 * pickaxe (`-S`, commits that add or remove a text), the commit message, the author, paths and a start date. The query
 * and result contract of the `search_commits` MCP tool.
 */

/** Most commits in one result, newest first across all repos searched. */
export const COMMIT_SEARCH_MAX_COMMITS = 200;
/** Most changed files listed per commit; a commit that touches more says so in `filesTruncated`. */
export const COMMIT_SEARCH_MAX_FILES = 20;
/** A subject longer than this (git joins the whole first paragraph of a message into it) is cut. */
export const COMMIT_SEARCH_SUBJECT_MAX_CHARS = 500;
/**
 * Most characters of subjects and paths in one result; the result goes to the agent twice (text and
 * `structuredContent`), as in code search.
 */
export const COMMIT_SEARCH_MAX_CHARS = 100_000;

/** One line of text for git, like the pattern of code search: no newline or control character except tab. */
const OneLine = CodeQuery.shape.pattern;

/** What to look for in one repo's history; the `search_commits` tool adds the choice of repos and the limit. */
export const CommitQuery = z.object({
  /** Commits whose changes add or remove this text (git's pickaxe, `-S`); with `regex`, a POSIX extended regular expression. */
  text: OneLine.optional(),
  /** Commits whose message contains this (`--grep`). */
  message: OneLine.optional(),
  /** Commits whose author name or e-mail contains this (`--author`). */
  author: OneLine.optional(),
  /** `text`, `message` and `author` are POSIX extended regular expressions instead of fixed strings. */
  regex: z.boolean(),
  ignoreCase: z.boolean(),
  /** Only commits that change these paths (git pathspecs); an empty list means the whole tree. */
  paths: CodePathspecs,
  /** Only commits made on this day or later (committer date, `YYYY-MM-DD`). */
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since: a date as YYYY-MM-DD")
    .optional(),
});
export type CommitQuery = z.infer<typeof CommitQuery>;

export const FoundCommit = z.object({
  repo: RepoId,
  hash: CommitHash,
  author: z.string(),
  /** ISO 8601, committer time: the time git orders the history and `since` by. */
  date: z.string(),
  /** Cut to `COMMIT_SEARCH_SUBJECT_MAX_CHARS`. */
  subject: z.string(),
  /**
   * The files the commit changed; with `text`, only those whose change adds or removes it, with `paths`, only those
   * among them. Empty for a merge commit, which git does not compare.
   */
  files: z.array(z.string()),
  filesTruncated: z.boolean(),
});
export type FoundCommit = z.infer<typeof FoundCommit>;

export const CommitSearchRepo = z.object({
  repo: RepoId,
  /** The commit whose history was searched; a repo without commits is not listed. */
  commit: CommitHash,
  /** Not every matching commit of this repo is in the result (the limit, or git's output was cut). */
  truncated: z.boolean(),
});
export type CommitSearchRepo = z.infer<typeof CommitSearchRepo>;

/** A repo git could not search (an invalid regular expression, git's time limit); the other repos still have results. */
export const CommitSearchFailure = z.object({
  repo: RepoId,
  message: z.string(),
});

export const SearchCommitsResult = z.object({
  /** Newest first (committer date) across all repos. */
  commits: z.array(FoundCommit),
  /**
   * Not every matching commit may be in the result: more than the limit or `COMMIT_SEARCH_MAX_CHARS`, git output cut,
   * or repos skipped; narrow the query.
   */
  truncated: z.boolean(),
  searched: z.array(CommitSearchRepo),
  failed: z.array(CommitSearchFailure),
  /** Repos not searched because the search ran out of time (`truncated` is then true). */
  skipped: z.array(RepoId),
});
export type SearchCommitsResult = z.infer<typeof SearchCommitsResult>;
