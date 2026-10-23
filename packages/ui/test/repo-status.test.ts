import { describe, expect, test } from "bun:test";
import type { RepoStatus } from "@trackwall/protocol";
import { branchLabel, repoStatusTone } from "../src/lib/repo-status.ts";

const ok = { kind: "ok", branch: "main", head: null, upstream: null } as const;

describe("stan repo w UI", () => {
  test("czyste repo ma ton ok, repo ze zmianami ton warning z liczbą zmian, niedostępne ton error", () => {
    const statuses: RepoStatus[] = [
      { ...ok, changes: 0 },
      { ...ok, changes: 3 },
      { kind: "unavailable", message: "brak katalogu" },
    ];
    expect(statuses.map(repoStatusTone)).toEqual([
      { tone: "ok", label: "czysto" },
      { tone: "warning", label: "3 zmiany" },
      { tone: "error", label: "niedostępne" },
    ]);
  });

  test("odłączony HEAD zamiast nazwy gałęzi", () => {
    expect([branchLabel({ ...ok, changes: 0 }), branchLabel({ ...ok, branch: null, changes: 0 })]).toEqual(["main", "odłączony HEAD"]);
  });
});
