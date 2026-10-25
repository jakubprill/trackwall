import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoIdFor } from "../src/modules/workspace/repo-id.ts";

describe("repoIdFor", () => {
  test("the directory name reduced to a slug, Polish letters without diacritics", () => {
    expect(repoIdFor(join("x", "Orders BFF"), new Set())).toBe("orders-bff");
    expect(repoIdFor(join("x", "Zażółć_repo.v2"), new Set())).toBe("zazolc_repo.v2");
    expect(repoIdFor(join("x", "--"), new Set())).toBe("repo");
  });

  test("a taken identifier gets the next free suffix", () => {
    expect(repoIdFor(join("x", "api"), new Set(["api", "api-2"]))).toBe("api-3");
  });
});
