import { describe, expect, test } from "bun:test";
import { onePageMore, pagesOf, requestKey, searchKey, searchProgress } from "../src/lib/remote-repo-search.ts";

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
    const key = searchKey(orders);
    const listed = { searchKey: key, pages: 1 };
    expect(searchProgress({ listed, key, pages: 2, failed: false, typing: false })).toBe("loading-more");
    expect(searchProgress({ listed: { searchKey: key, pages: 2 }, key, pages: 2, failed: false, typing: false })).toBe("settled");
    expect(searchProgress({ listed, key, pages: 2, failed: true, typing: false })).toBe("settled");
    expect(searchProgress({ listed: undefined, key, pages: 1, failed: false, typing: false })).toBe("settled");
  });

  test("Show more after a new search fetches its second page, not one after the old search's pages", () => {
    const shown = { searchKey: searchKey(orders), pages: 4 };
    const key = searchKey({ ...orders, query: "billing" });
    expect(onePageMore(shown, key)).toEqual({ searchKey: key, pages: 2 });
  });
});

describe("typing in the Add repo search", () => {
  const listed = { searchKey: searchKey(orders), pages: 1 };

  test("the list of the previous search stays on screen and counts as searching until the new search answers", () => {
    const key = searchKey({ ...orders, query: "orders-api" });
    expect(searchProgress({ listed, key, pages: 1, failed: false, typing: false })).toBe("searching");
    expect(searchProgress({ listed: { searchKey: key, pages: 1 }, key, pages: 1, failed: false, typing: false })).toBe("settled");
  });

  test("a query typed but not yet sent already counts as searching, also over a list that answers the same search", () => {
    expect(searchProgress({ listed, key: listed.searchKey, pages: 1, failed: false, typing: true })).toBe("searching");
  });

  test("after a failed search nothing is on its way: the error shows over the previous list", () => {
    expect(searchProgress({ listed, key: searchKey({ ...orders, query: "x" }), pages: 1, failed: true, typing: false })).toBe("settled");
  });

  test("a request is new when the search or its pages change, and only then", () => {
    const key = searchKey(orders);
    expect(requestKey(key, 1)).toBe(requestKey(searchKey({ ...orders }), 1));
    expect(requestKey(key, 2)).not.toBe(requestKey(key, 1));
    expect(requestKey(searchKey({ ...orders, query: "order" }), 1)).not.toBe(requestKey(key, 1));
  });
});
