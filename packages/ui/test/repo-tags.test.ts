import { describe, expect, test } from "bun:test";
import type { RepoTags } from "@trackwall/protocol";
import { hasAllTags, tagCounts, tagsByRepo, toggleTag } from "../src/lib/repo-tags.ts";

const tag = (name: string) => ({ name, reason: "reason" });
const list: RepoTags[] = [
  { kind: "ok", repo: "orders-bff", tags: [tag("bff"), tag("java")] },
  { kind: "ok", repo: "catalog", tags: [tag("java")] },
  { kind: "ok", repo: "web", tags: [tag("frontend")] },
  { kind: "unavailable", repo: "broken", message: "git cannot read the repo" },
];

describe("repo filter by tags", () => {
  test("tag counts: most frequent first, by name on a tie", () => {
    expect(tagCounts(tagsByRepo(list), [])).toEqual([
      { name: "java", count: 2 },
      { name: "bff", count: 1 },
      { name: "frontend", count: 1 },
    ]);
  });

  test("a selected tag that no repo has any more stays in the list with count 0", () => {
    expect(tagCounts(tagsByRepo(list), ["core-api"]).at(-1)).toEqual({ name: "core-api", count: 0 });
    expect(tagCounts(new Map(), ["java"])).toEqual([{ name: "java", count: 0 }]);
  });

  test("a repo must have every selected tag; without a selection every repo matches, also one without tags", () => {
    const byRepo = tagsByRepo(list);
    const matching = (selected: string[]) => [...byRepo.keys()].filter((repo) => hasAllTags(byRepo.get(repo), selected));
    expect(matching([])).toEqual(["orders-bff", "catalog", "web", "broken"]);
    expect(matching(["java"])).toEqual(["orders-bff", "catalog"]);
    expect(matching(["java", "bff"])).toEqual(["orders-bff"]);
  });

  test("clicking a tag adds or removes it", () => {
    expect(toggleTag(["java"], "bff")).toEqual(["java", "bff"]);
    expect(toggleTag(["java", "bff"], "java")).toEqual(["bff"]);
  });
});
