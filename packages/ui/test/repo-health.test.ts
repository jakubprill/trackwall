import { describe, expect, test } from "bun:test";
import type { Repo } from "@trackwall/protocol";
import { repoHealth } from "../src/RepoStatusBadges.tsx";

const ok = { kind: "ok", branch: "main", head: null, upstream: null } as const;

describe("repoHealth", () => {
  test("czyste repo świeci na zielono, ze zmianami na bursztynowo, niedostępne na czerwono", () => {
    const repos: Repo[] = [
      { id: "a", path: "/a", status: { ...ok, changes: 0 } },
      { id: "b", path: "/b", status: { ...ok, changes: 3 } },
      { id: "c", path: "/c", status: { kind: "unavailable", message: "brak katalogu" } },
    ];
    expect(repos.map(repoHealth)).toEqual([
      { tone: "ok", label: "czyste" },
      { tone: "warning", label: "ze zmianami" },
      { tone: "error", label: "niedostępne" },
    ]);
  });
});
