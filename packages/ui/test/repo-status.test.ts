import { describe, expect, test } from "bun:test";
import type { RepoStatus } from "@trackwall/protocol";
import { branchLabel, listNeedsSettings, repoStatusTone } from "../src/lib/repo-status.ts";

const ok = { kind: "ok", branch: "main", head: null, upstream: null, untracked: 0 } as const;

describe("stan repo w UI", () => {
  test("czyste repo ma ton ok, repo ze zmianami ton warning ze zmienionymi i nowymi plikami osobno, niedostępne ton error", () => {
    const statuses: RepoStatus[] = [
      { ...ok, changes: 0 },
      { ...ok, changes: 3 },
      { ...ok, changes: 4, untracked: 1 },
      { ...ok, changes: 2, untracked: 2 },
      { kind: "unavailable", message: "brak katalogu" },
    ];
    expect(statuses.map(repoStatusTone)).toEqual([
      { tone: "ok", label: "clean" },
      { tone: "warning", label: "3 changed" },
      { tone: "warning", label: "3 changed, 1 new" },
      { tone: "warning", label: "2 new" },
      { tone: "error", label: "unavailable" },
    ]);
  });

  test("gałąź pokazuje swoją nazwę, a bez gałęzi napis „odłączony HEAD”", () => {
    expect([branchLabel({ ...ok, changes: 0 }), branchLabel({ ...ok, branch: null, changes: 0 })]).toEqual(["main", "detached HEAD"]);
  });
});

describe("lista repo do poprawienia w ustawieniach", () => {
  test("folder z projektami do poprawienia w ustawieniach: zniknął albo zły workspace.yaml", () => {
    expect(listNeedsSettings("projects_dir_unavailable")).toBe(true);
    expect(listNeedsSettings("invalid_config")).toBe(true);
    expect(listNeedsSettings("not_found")).toBe(false);
    expect(listNeedsSettings(undefined)).toBe(false);
  });
});
