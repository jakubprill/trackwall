import { describe, expect, test } from "bun:test";
import { countLabel, pluralNoun } from "../src/plural.ts";

const repo = { one: "repo", other: "repos" };

describe("liczba mnoga", () => {
  test("forma pojedyncza tylko dla 1, mnoga dla 0 i 2+", () => {
    expect([0, 1, 2, 5].map((n) => pluralNoun(n, repo))).toEqual(["repos", "repo", "repos", "repos"]);
  });

  test("countLabel stawia liczbę przed rzeczownikiem", () => {
    expect([0, 1, 2].map((n) => countLabel(n, repo))).toEqual(["0 repos", "1 repo", "2 repos"]);
  });
});
