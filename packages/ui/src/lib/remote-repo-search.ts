import type { RemoteRepoSearch } from "@trackwall/protocol";

/**
 * "Show more" in the "Add repo" view (ADR-201); pure functions, tests in `test/remote-repo-search.test.ts`. The pages
 * shown belong to one search: changing the query or a filter starts again at the first page.
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

/**
 * "Show more" is on its way: the list on screen has fewer pages than asked for, and the last request did not fail
 * (after a failure the button is back, so that pressing it again retries).
 */
export function loadingMore(shownPages: number | undefined, pages: number, failed: boolean): boolean {
  return shownPages !== undefined && shownPages < pages && !failed;
}

/** One page more in the search `key`. */
export function onePageMore(shown: ShownPages, key: string): ShownPages {
  return { searchKey: key, pages: pagesOf(shown, key) + 1 };
}
