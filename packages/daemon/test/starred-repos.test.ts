import { describe, expect, test } from "bun:test";
import { MAX_STARRED_REPOS } from "@trackwall/protocol";
import { withStar } from "../src/modules/workspace/starred-repos.ts";

describe("starring a repo (ADR-192)", () => {
  test("a new star goes to the end, and unstarring takes the repo out wherever it is", () => {
    expect(withStar(["web"], "orders-api", true)).toEqual(["web", "orders-api"]);
    expect(withStar(["web", "orders-api", "docs"], "orders-api", false)).toEqual(["web", "docs"]);
  });

  test("starring a starred repo or unstarring one that is not starred gives the same list back", () => {
    const ids = ["web"];
    expect(withStar(ids, "web", true)).toBe(ids);
    expect(withStar(ids, "orders-api", false)).toBe(ids);
  });

  test("a star over the limit is refused, and unstarring still works there", () => {
    const full = Array.from({ length: MAX_STARRED_REPOS }, (_, i) => `repo-${i}`);
    expect(() => withStar(full, "one-more", true)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(withStar(full, "repo-0", false)).toHaveLength(MAX_STARRED_REPOS - 1);
  });
});
