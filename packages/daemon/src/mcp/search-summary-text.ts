/**
 * The closing lines of a search result's text (ADR-187): how many repos were searched, which failed and why, which
 * were not searched, and whether something may be missing. Code search and commit search share them, so an agent
 * reads the same words after both.
 */

/** Commit hashes in a result's text: as long as git's own abbreviation in a large repo, so `git show` takes them. */
export const TEXT_HASH_CHARS = 12;

export interface SearchSummary {
  searched: readonly { repo: string; truncated: boolean }[];
  failed: readonly { repo: string; message: string }[];
  skipped: readonly string[];
  truncated: boolean;
}

/**
 * `found` names what was found (`matches`, `commits`); `withHits` is how many searched repos had any; `skipReason`
 * says why a repo can be left out (code search stops at its limit, commit search only when time runs out).
 */
export function searchSummaryLines(summary: SearchSummary, found: string, withHits: number, skipReason: string): string[] {
  const { searched, failed, skipped, truncated } = summary;
  const lines = [`Searched ${searched.length} ${searched.length === 1 ? "repo" : "repos"}; ${withHits} with ${found}.`];
  for (const failure of failed) lines.push(`Failed in ${failure.repo}: ${failure.message}`);
  if (skipped.length > 0) lines.push(`Not searched (${skipReason}): ${skipped.join(", ")}`);
  if (!truncated) return lines;
  const cut = searched.filter((r) => r.truncated).map((r) => r.repo);
  const where = cut.length > 0 ? ` (in ${cut.join(", ")})` : "";
  lines.push(`Truncated: more ${found} may exist${where}; narrow the query.`);
  return lines;
}
