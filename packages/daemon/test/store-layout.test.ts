import { describe, expect, test } from "bun:test";
import { moveToReposFolder, storePath } from "../src/modules/local-config/store-layout.ts";

describe("the layout of the workspace store", () => {
  test("a repo's local config file lies under repos/ by the name of the repo's folder", () => {
    expect(storePath("/home/me/Dev/orders", "mise.local.toml")).toBe("repos/orders/mise.local.toml");
  });

  test("only a local config file right under a repo's folder is in the old place and moves into repos/", () => {
    expect(
      moveToReposFolder([
        "orders/mise.local.toml",
        "repos/mise.toml",
        "repos/web/.worktreeinclude",
        "knowledge/flaky-tests.md",
        "orders/notes.md",
        "README.md",
      ]),
    ).toEqual([
      { from: "orders/mise.local.toml", to: "repos/orders/mise.local.toml" },
      { from: "repos/mise.toml", to: "repos/repos/mise.toml" },
    ]);
  });
});
