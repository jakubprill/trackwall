import type { CodeQuery } from "@trackwall/protocol";
import { git } from "./git.ts";

/**
 * Code search in one repo (ADR-40): `git grep` over the commit's objects, without the working tree and without
 * `textconv`, so the repo cannot make git run any program, and paths cannot leave the commit tree.
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

export async function grep(
  dir: string,
  commit: string,
  query: CodeQuery,
  maxBytes: number,
): Promise<{ lines: GrepLine[]; truncated: boolean }> {
  const args = [
    "grep",
    "-n",
    "-z",
    "-I",
    "--column",
    "--no-color",
    "--no-textconv",
    query.regex ? "-E" : "-F",
    ...(query.ignoreCase ? ["-i"] : []),
    `-C${query.context}`,
    "-e",
    query.pattern,
    commit,
    "--",
    ...query.paths,
  ];
  // Exit code 1: nothing matched.
  const { stdout, truncated } = await git(dir, args, { maxBytes, okExitCodes: [1], timeoutMs: GREP_TIMEOUT_MS });
  const lines = parseGrep(stdout.toString("utf8"), commit);
  // The last line of cut output may be incomplete.
  return { lines: truncated ? lines.slice(0, -1) : lines, truncated };
}

/**
 * Output of `git grep -n -z --column <commit>`: a match line is `<commit>:<path>\0<line>\0<column>\0<text>`, a
 * context line the same without the column, and `--` separates groups. The text has no NUL (`-I` skips binary files),
 * so the number of fields tells a match from context; a line of any other shape (a path with a newline) is skipped.
 */
export function parseGrep(out: string, commit: string): GrepLine[] {
  const prefix = `${commit}:`;
  const lines: GrepLine[] = [];
  for (const raw of out.split("\n")) {
    if (!raw.startsWith(prefix)) continue;
    const fields = raw.slice(prefix.length).split("\0");
    const [path, line, ...rest] = fields;
    const isMatch = rest.length === 2 && /^\d+$/.test(rest[0] ?? "");
    const text = (isMatch ? rest[1] : rest.join("\0"))?.replace(/\r$/, "");
    if (path === undefined || line === undefined || !/^\d+$/.test(line) || text === undefined || rest.length === 0) continue;
    lines.push({ path, line: Number(line), column: isMatch ? Number(rest[0]) : null, text });
  }
  return lines;
}
