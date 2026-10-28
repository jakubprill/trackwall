import { describe, expect, test } from "bun:test";
import { REPO_TABS } from "../src/lib/repo-tabs.ts";

describe("tabs of one repo", () => {
  test("the card is the first tab, so a repo opens on it, and the README is the last", () => {
    expect(REPO_TABS.map((t) => t.label)).toEqual(["Card", "Files", "Commits", "Changes", "mise tasks", "README"]);
  });
});
