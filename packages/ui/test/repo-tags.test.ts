import { describe, expect, test } from "bun:test";
import type { RepoTags } from "@trackwall/protocol";
import { hasAllTags, tagCounts, tagsByRepo, toggleTag } from "../src/lib/repo-tags.ts";

const tag = (name: string) => ({ name, reason: "powód" });
const list: RepoTags[] = [
  { kind: "ok", repo: "orders-bff", tags: [tag("bff"), tag("java")] },
  { kind: "ok", repo: "catalog", tags: [tag("java")] },
  { kind: "ok", repo: "web", tags: [tag("frontend")] },
  { kind: "unavailable", repo: "zepsute", message: "git nie czyta repo" },
];

describe("filtr repo po tagach", () => {
  test("liczby tagów: najczęstsze najpierw, przy remisie po nazwie", () => {
    expect(tagCounts(tagsByRepo(list))).toEqual([
      { name: "java", count: 2 },
      { name: "bff", count: 1 },
      { name: "frontend", count: 1 },
    ]);
  });

  test("repo musi mieć każdy wybrany tag; bez wyboru pasuje każde, także bez tagów", () => {
    const byRepo = tagsByRepo(list);
    const matching = (selected: string[]) => [...byRepo.keys()].filter((repo) => hasAllTags(byRepo.get(repo), selected));
    expect(matching([])).toEqual(["orders-bff", "catalog", "web", "zepsute"]);
    expect(matching(["java"])).toEqual(["orders-bff", "catalog"]);
    expect(matching(["java", "bff"])).toEqual(["orders-bff"]);
  });

  test("kliknięcie tagu dodaje go albo zdejmuje", () => {
    expect(toggleTag(["java"], "bff")).toEqual(["java", "bff"]);
    expect(toggleTag(["java", "bff"], "java")).toEqual(["bff"]);
  });
});
