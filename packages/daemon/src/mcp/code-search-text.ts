import type { CodeFile, CodeMatch, SearchCodeResult } from "@trackwall/protocol";
import { searchSummaryLines, TEXT_HASH_CHARS } from "./search-summary-text.ts";

/**
 * The text of a `search_code` result, which is all the model behind Copilot CLI reads of it (ADR-187): grep-like
 * lines grouped by repo and file instead of JSON, so the repo, path and field names are not repeated for every match.
 * A repo heading is `## <repo> @<commit>`, a file heading `### <path>`; a match line is `<line>:<text>`, a context line
 * `<line>-<text>`, and `--` separates groups that are not next to each other, as in git grep's own output.
 */
export function codeSearchText(result: SearchCodeResult): string {
  const commits = new Map(result.searched.map((r) => [r.repo, r.commit.slice(0, TEXT_HASH_CHARS)]));
  const body = result.files.length > 0 ? fileLines(result.files, commits) : matchLines(result.matches, commits);
  const withHits = new Set([...result.matches, ...result.files].map((m) => m.repo)).size;
  return [
    ...(withHits === 0 ? ["No matches."] : body),
    ...searchSummaryLines(result, "matches", withHits, "the limit was reached or time ran out"),
  ].join("\n");
}

function fileLines(files: readonly CodeFile[], commits: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];
  let repo: string | undefined;
  for (const file of files) {
    if (file.repo !== repo) {
      repo = file.repo;
      lines.push(repoHeading(repo, commits));
    }
    lines.push(`${file.path} (${file.matches})`);
  }
  return lines;
}

function matchLines(matches: readonly CodeMatch[], commits: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];
  let repo: string | undefined;
  for (const group of byFile(matches)) {
    if (group.repo !== repo) {
      repo = group.repo;
      lines.push(repoHeading(repo, commits));
    }
    lines.push(`### ${group.path}`, ...fileText(group.matches));
  }
  return lines;
}

function repoHeading(repo: string, commits: ReadonlyMap<string, string>): string {
  const commit = commits.get(repo);
  if (commit === undefined) throw new Error(`code search: matches of repo ${repo}, which is not among the repos searched`);
  return `## ${repo} @${commit}`;
}

/** Matches come ordered by repo, then path, then line, so a file's matches are next to each other. */
function byFile(matches: readonly CodeMatch[]): { repo: string; path: string; matches: CodeMatch[] }[] {
  const groups: { repo: string; path: string; matches: CodeMatch[] }[] = [];
  for (const match of matches) {
    const last = groups.at(-1);
    if (last?.repo === match.repo && last.path === match.path) last.matches.push(match);
    else groups.push({ repo: match.repo, path: match.path, matches: [match] });
  }
  return groups;
}

/**
 * One file's lines, each once: neighbouring matches share context lines, and a line that is a match is shown as one
 * even where it is also another match's context.
 */
function fileText(matches: readonly CodeMatch[]): string[] {
  const byLine = new Map<number, { text: string; match: boolean }>();
  for (const m of matches) {
    for (const l of [...m.before, ...m.after]) if (!byLine.has(l.line)) byLine.set(l.line, { text: l.text, match: false });
    byLine.set(m.line, { text: m.text, match: true });
  }
  const lines: string[] = [];
  let previous: number | undefined;
  for (const [line, { text, match }] of [...byLine].sort(([a], [b]) => a - b)) {
    if (previous !== undefined && line > previous + 1) lines.push("--");
    lines.push(`${line}${match ? ":" : "-"}${text}`);
    previous = line;
  }
  return lines;
}
