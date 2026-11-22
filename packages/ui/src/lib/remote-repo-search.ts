import type { RemoteRepoSearch } from "@trackwall/protocol";

/**
 * The search and "Show more" in the "Add repo" view (ADR-201); pure functions, tests in `test/remote-repo-search.test.ts`.
 * The pages shown belong to one search: changing the query or a filter starts again at the first page.
 */

export type RemoteRepoFilters = Omit<RemoteRepoSearch, "pages">;

/** How many pages the user asked for, and for which search (`searchKey`). */
export interface ShownPages {
  searchKey: string;
  pages: number;
}

/** A key that changes exactly when the search, without its pages, changes. */
export function searchKey(filters: RemoteRepoFilters): string {
  return JSON.stringify([filters.query, filters.scope, filters.topic, filters.language, filters.starredOnHost]);
}

/** The pages to ask for: those the user asked for in this search, or the first one in a new search. */
export function pagesOf(shown: ShownPages, key: string): number {
  return shown.searchKey === key ? shown.pages : 1;
}

/** What the list on screen is waiting for: nothing, a new search (`searching`), or another page of the same one. */
export type SearchProgress = "settled" | "searching" | "loading-more";

/**
 * The list on screen stays while a new search runs, so that typing does not empty and refill the view; this says what it
 * waits for. `listed` is the search and pages of the list on screen, `key` and `pages` those asked for, and `typing` a
 * query or filter typed but not sent yet (the debounce). After a failed request nothing is on its way: the error shows,
 * and "Show more" is back so that pressing it again retries.
 */
export function searchProgress({
  listed,
  key,
  pages,
  failed,
  typing,
}: {
  listed: ShownPages | undefined;
  key: string;
  pages: number;
  failed: boolean;
  typing: boolean;
}): SearchProgress {
  if (typing) return "searching";
  if (failed || listed === undefined) return "settled";
  if (listed.searchKey !== key) return "searching";
  return listed.pages < pages ? "loading-more" : "settled";
}

/** The key of one request: the search and its pages; a change of it asks the hosts again. */
export function requestKey(key: string, pages: number): string {
  return JSON.stringify([key, pages]);
}

/** One page more in the search `key`. */
export function onePageMore(shown: ShownPages, key: string): ShownPages {
  return { searchKey: key, pages: pagesOf(shown, key) + 1 };
}
