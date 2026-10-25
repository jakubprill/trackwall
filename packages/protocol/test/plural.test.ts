import { describe, expect, test } from "bun:test";
import { countLabel, pluralNoun } from "../src/plural.ts";

const repo = { one: "repo", other: "repos" };

describe("plural", () => {
  test("the singular only for 1, the plural for 0 and 2+", () => {
    expect([0, 1, 2, 5].map((n) => pluralNoun(n, repo))).toEqual(["repos", "repo", "repos", "repos"]);
  });

  test("countLabel puts the number before the noun", () => {
    expect([0, 1, 2].map((n) => countLabel(n, repo))).toEqual(["0 repos", "1 repo", "2 repos"]);
  });
});
