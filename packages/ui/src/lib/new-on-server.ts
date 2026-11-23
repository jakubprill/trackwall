import type { ServerCheckState } from "@trackwall/protocol";

/**
 * When the server check found that the server moved the repo's `remoteBranch` (`origin/main`) past what the repo last
 * fetched (ADR-295, ADR-297): the moment it read the repo, or `null`, also when the repo fetched after that moment, which
 * brought what the server had then. One rule for All repos (the checked-out branch's upstream) and the New task form
 * (the default branch); tests in `test/all-repos.test.ts` and `test/new-task-base.test.ts`.
 */
export function newOnServerAt(
  serverCheck: ServerCheckState | undefined,
  repo: string,
  remoteBranch: string,
  fetchedAt: string | null,
): string | null {
  const found = serverCheck?.last?.newCommits.find((n) => n.repo === repo && n.remoteBranches.includes(remoteBranch));
  if (found === undefined) return null;
  return fetchedAt !== null && Date.parse(fetchedAt) >= Date.parse(found.checkedAt) ? null : found.checkedAt;
}
