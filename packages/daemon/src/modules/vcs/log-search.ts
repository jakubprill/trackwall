import type { CommitQuery } from "@trackwall/protocol";
import { git } from "./git.ts";

/**
 * `git log` over the history of one commit for commit search (ADR-149). The query goes to git as whole arguments
 * (`-S<text>`, `--grep=<message>`), so a value that starts with `-` stays a value, and paths after `--`. Without
 * `textconv`, external diff programs and rename detection: the repo cannot make git run a program, and a search stays
 * a plain walk over the objects.
 */

/** One commit of the result, before `workspace` adds the repo id. */
export interface LoggedCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

/** Walking a long history with the pickaxe compares every commit with its parent, which takes longer than a grep. */
const LOG_SEARCH_TIMEOUT_MS = 30_000;

/** A commit's record starts with this byte, so that its header can be told from the NUL-separated file names after it. */
const RECORD_START = "\x1e";
const FORMAT = `--format=${RECORD_START}%H%x1f%an%x1f%aI%x1f%s`;

/** The git options of a query: fixed strings with `-F`, regular expressions with `-E` and `--pickaxe-regex`. */
function logSearchArgs(query: CommitQuery): string[] {
  const args = [query.regex ? "-E" : "-F"];
  if (query.ignoreCase) args.push("-i");
  if (query.text !== undefined) args.push(`-S${query.text}`, ...(query.regex ? ["--pickaxe-regex"] : []));
  if (query.message !== undefined) args.push(`--grep=${query.message}`);
  if (query.author !== undefined) args.push(`--author=${query.author}`);
  if (query.since !== undefined) args.push(`--since=${query.since}`);
  return args;
}

/** At most `limit` commits of `commit`'s history that match the query, newest first. */
export async function searchLog(
  dir: string,
  commit: string,
  query: CommitQuery,
  limit: number,
  maxBytes: number,
): Promise<{ commits: LoggedCommit[]; truncated: boolean }> {
  const args = [
    "log",
    "-z",
    "--no-textconv",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    `--max-count=${limit}`,
    FORMAT,
    ...logSearchArgs(query),
    commit,
    "--",
    ...query.paths,
  ];
  const { stdout, truncated } = await git(dir, args, { maxBytes, timeoutMs: LOG_SEARCH_TIMEOUT_MS });
  const commits = parseLogSearch(stdout.toString("utf8"));
  // The last record of cut output may miss files, so it is dropped.
  return { commits: truncated ? commits.slice(0, -1) : commits, truncated };
}

/**
 * Output of `git log -z --name-only` with `FORMAT`: a record is `\x1e<hash>\x1f<author>\x1f<date>\x1f<subject>\0`,
 * then a newline and the changed paths each ended by NUL (nothing for a merge commit).
 */
export function parseLogSearch(out: string): LoggedCommit[] {
  return out
    .split(RECORD_START)
    .filter((record) => record !== "")
    .map((record) => {
      const [header = "", ...paths] = record.split("\0");
      const [hash = "", author = "", date = "", subject = ""] = header.split("\x1f");
      const files = paths.map((path) => path.replace(/^\n/, "")).filter((path) => path !== "");
      return { hash, author, date, subject, files };
    });
}
