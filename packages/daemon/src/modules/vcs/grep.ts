import type { CodeQuery } from "@trackwall/protocol";
import { git } from "./git.ts";

/**
 * `git grep` over the objects of a commit: source files for repo cards (ADR-30) and code search (ADR-40). Without the
 * working tree, `textconv` and submodules, so the repo cannot make git run any program or read another repository,
 * and paths cannot leave the commit tree. Every search here goes through `commitGrep`, which owns these flags.
 */

export interface GrepLine {
  path: string;
  line: number;
  /** Column of the first match; `null` for a context line. */
  column: number | null;
  text: string;
}

/** Searching a large repo takes longer than ordinary git commands: git inflates every file of the commit. */
const GREP_TIMEOUT_MS = 30_000;

/** One search: options before `-e`, and what ends one output record (NUL after a name with `-l`, else a newline). */
interface GrepRun {
  options: readonly string[];
  pattern: string;
  pathspecs: readonly string[];
  recordEnd: "\0" | "\n";
  maxBytes: number;
}

/**
 * `git grep <options> -e <pattern> <commit> -- <pathspecs>` with NUL-separated output. Exit code 1 means nothing
 * matched; the last record of cut output may be incomplete, so it is dropped.
 */
async function commitGrep(dir: string, commit: string, run: GrepRun): Promise<{ out: string; truncated: boolean }> {
  const { options, pattern, pathspecs, recordEnd, maxBytes } = run;
  const args = [
    "grep",
    "-z",
    "-I",
    "--no-color",
    "--no-textconv",
    "--no-recurse-submodules",
    ...options,
    "-e",
    pattern,
    commit,
    "--",
    ...pathspecs,
  ];
  const { stdout, truncated } = await git(dir, args, { maxBytes, okExitCodes: [1], timeoutMs: GREP_TIMEOUT_MS });
  const out = stdout.toString("utf8");
  return { out: truncated ? out.slice(0, Math.max(0, out.lastIndexOf(recordEnd))) : out, truncated };
}

/**
 * Files of the commit matching `globs` (git pathspecs, e.g. `*.java`) whose content matches the ERE `pattern`.
 * `truncated` when the list went past `maxBytes` and is incomplete.
 */
export async function grepFiles(
  dir: string,
  commit: string,
  pattern: string,
  globs: readonly string[],
  maxBytes: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const { out, truncated } = await commitGrep(dir, commit, { options: ["-l", "-E"], pattern, pathspecs: globs, recordEnd: "\0", maxBytes });
  const prefix = `${commit}:`;
  const paths = out
    .split("\0")
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
  return { paths, truncated };
}

/** Match and context lines of a code search query in the commit (ADR-40). */
export async function grep(
  dir: string,
  commit: string,
  query: CodeQuery,
  maxBytes: number,
): Promise<{ lines: GrepLine[]; truncated: boolean }> {
  const options = ["-n", "--column", query.regex ? "-E" : "-F", ...(query.ignoreCase ? ["-i"] : []), `-C${query.context}`];
  const { out, truncated } = await commitGrep(dir, commit, {
    options,
    pattern: query.pattern,
    pathspecs: query.paths,
    recordEnd: "\n",
    maxBytes,
  });
  return { lines: parseGrep(out, commit), truncated };
}

/**
 * Output of `git grep -n -z --column <commit>`: a match line is `<commit>:<path>\0<line>\0<column>\0<text>`, a
 * context line the same without the column, and `--` separates groups. `-I` looks only at the start of a file, so the
 * text can still hold a NUL: a line is a match when it has a numeric third field and a fourth one, and the rest is
 * its text. A context line whose text starts with digits and a NUL would look like a match; that is accepted. A line
 * of any other shape (a path with a newline) is skipped.
 */
export function parseGrep(out: string, commit: string): GrepLine[] {
  const prefix = `${commit}:`;
  const lines: GrepLine[] = [];
  for (const raw of out.split("\n")) {
    if (!raw.startsWith(prefix)) continue;
    const [path = "", line = "", ...rest] = raw.slice(prefix.length).split("\0");
    if (!/^\d+$/.test(line) || rest.length === 0) continue;
    const [first = "", ...afterFirst] = rest;
    const isMatch = afterFirst.length > 0 && /^\d+$/.test(first);
    const text = (isMatch ? afterFirst : rest).join("\0").replace(/\r$/, "");
    lines.push({ path, line: Number(line), column: isMatch ? Number(first) : null, text });
  }
  return lines;
}
