import { describe, expect, test } from "bun:test";
import { loadingMore, onePageMore, pagesOf, searchKey } from "../src/lib/remote-repo-search.ts";

const orders = { query: "orders", scope: "member", topic: "", language: "", starredOnHost: false } as const;

describe("Show more in the Add repo view", () => {
  test("Show more adds a page to the search on screen", () => {
    const key = searchKey(orders);
    const once = onePageMore({ searchKey: key, pages: 1 }, key);
    expect(once).toEqual({ searchKey: key, pages: 2 });
    expect(pagesOf(onePageMore(once, key), key)).toBe(3);
  });

  test("changing the query or a filter starts again at the first page", () => {
    const shown = { searchKey: searchKey(orders), pages: 4 };
    expect(pagesOf(shown, searchKey({ ...orders, query: "order" }))).toBe(1);
    expect(pagesOf(shown, searchKey({ ...orders, scope: "visible" }))).toBe(1);
    expect(pagesOf(shown, searchKey({ ...orders, topic: "java" }))).toBe(1);
    expect(pagesOf(shown, searchKey({ ...orders, language: "Java" }))).toBe(1);
    expect(pagesOf(shown, searchKey({ ...orders, starredOnHost: true }))).toBe(1);
  });

  test("Show more is loading until the list has the pages asked for, and a failed request gives the button back", () => {
    expect(loadingMore(1, 2, false)).toBe(true);
    expect(loadingMore(2, 2, false)).toBe(false);
    expect(loadingMore(1, 2, true)).toBe(false);
    expect(loadingMore(undefined, 1, false)).toBe(false);
  });

  test("Show more after a new search fetches its second page, not one after the old search's pages", () => {
    const shown = { searchKey: searchKey(orders), pages: 4 };
    const key = searchKey({ ...orders, query: "billing" });
    expect(onePageMore(shown, key)).toEqual({ searchKey: key, pages: 2 });
  });
});
