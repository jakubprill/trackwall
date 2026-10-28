import type { Repo } from "@trackwall/protocol";

/**
 * Lazy loading of the repo list (ADR-113): the quick list (`entries`) has every repo as `loading`, and the statuses come in
 * batches, the repos the view shows first. Pure rules for `useRepoList`.
 */

/** How many repos one `repos` request asks for: two rounds of git slots on Windows, so the first answer comes soon. */
export const REPO_BATCH_SIZE = 8;

/**
 * The repos of the list in batches of `size`: those in `first` that are on the list, in that order, then the rest in list
 * order. Every repo once.
 */
export function repoBatches(ids: readonly string[], first: readonly string[], size: number): string[][] {
  const listed = new Set(ids);
  const front = [...new Set(first)].filter((id) => listed.has(id));
  const taken = new Set(front);
  const order = [...front, ...ids.filter((id) => !taken.has(id))];
  const batches: string[][] = [];
  for (let i = 0; i < order.length; i += size) batches.push(order.slice(i, i + size));
  return batches;
}

/** The quick list with every repo whose status has come replaced by it; the rest stay `loading`, in the list's order. */
export function withLoadedRepos(entries: readonly Repo[], loaded: ReadonlyMap<string, Repo>): Repo[] {
  return entries.map((entry) => loaded.get(entry.id) ?? entry);
}
