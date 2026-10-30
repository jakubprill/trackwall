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

/**
 * Every field ends with NUL, the one byte git never puts in a subject, a name or a path: a record is an empty field,
 * then hash, author, committer date and subject, then the changed paths (`-z --name-only`).
 */
const FORMAT = "--format=%x00%H%x00%an%x00%cI%x00%s";

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
 * Output of `git log -z --name-only` with `FORMAT`: per commit `\0<hash>\0<author>\0<date>\0<subject>\0`, then a newline
 * and the changed paths each ended by NUL (nothing for a merge commit). The header is read by position, so an empty
 * subject or author is still a field; the first empty field after the paths starts the next commit.
 */
export function parseLogSearch(out: string): LoggedCommit[] {
  const fields = out.split("\0");
  const commits: LoggedCommit[] = [];
  let i = 0;
  while (i < fields.length) {
    if (fields[i] !== "") {
      i++;
      continue;
    }
    const [hash = "", author = "", date = "", subject = ""] = fields.slice(i + 1, i + 5);
    const files: string[] = [];
    for (i += 5; i < fields.length && fields[i] !== ""; i++) files.push((fields[i] ?? "").replace(/^\n/, ""));
    if (hash !== "") commits.push({ hash: hash.replace(/^\n/, ""), author, date, subject, files });
  }
  return commits;
}
