import type { SearchCommitsResult } from "@trackwall/protocol";
import { searchSummaryLines, TEXT_HASH_CHARS } from "./search-summary-text.ts";

/**
 * The text of a `search_commits` result, which is all the model behind Copilot CLI reads of it (ADR-187): a line per
 * commit, `<repo> <hash> <day> <author>: <subject>`, newest first, then the files it changed, indented.
 */
export function commitSearchText(result: SearchCommitsResult): string {
  const lines: string[] = result.commits.length === 0 ? ["No commits found."] : [];
  for (const c of result.commits) {
    lines.push(`${c.repo} ${c.hash.slice(0, TEXT_HASH_CHARS)} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`);
    lines.push(...c.files.map((f) => `  ${f}`));
    if (c.filesTruncated) lines.push("  (more files)");
  }
  const withHits = new Set(result.commits.map((c) => c.repo)).size;
  return [...lines, ...searchSummaryLines(result, "commits", withHits, "time ran out")].join("\n");
}
