import { describe, expect, test } from "bun:test";
import { starredFirst } from "../src/lib/starred-repos.ts";

const repos = [{ id: "api" }, { id: "docs" }, { id: "orders" }, { id: "web" }];

describe("the repo list with stars", () => {
  test("starred repos come first in the list's order, and the rest follow in theirs", () => {
    expect(starredFirst(repos, ["web", "docs"]).map((r) => r.id)).toEqual(["docs", "web", "api", "orders"]);
  });

  test("without stars the list keeps its order, and a star of a repo not on the list changes nothing", () => {
    expect(starredFirst(repos, []).map((r) => r.id)).toEqual(["api", "docs", "orders", "web"]);
    expect(starredFirst(repos, ["gone"]).map((r) => r.id)).toEqual(["api", "docs", "orders", "web"]);
  });
});
