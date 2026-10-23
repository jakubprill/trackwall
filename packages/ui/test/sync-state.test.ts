import { describe, expect, test } from "bun:test";
import type { SyncRepo } from "@trackwall/protocol";
import { listSyncBadge, syncProgress, syncRepoTone } from "../src/lib/sync-state.ts";

const target = { repo: "api", path: "/projekty/api" };

describe("synchronizacja w UI", () => {
  test("wynik repo ma ton i krótki tekst: trwające i pominięte ostrzegają, nieudane to błąd", () => {
    const repos: SyncRepo[] = [
      { ...target, state: "waiting" },
      { ...target, state: "running" },
      { ...target, state: "updated", branch: "main", commits: 1 },
      { ...target, state: "updated", branch: "main", commits: 3 },
      { ...target, state: "updated", branch: "main", commits: 12 },
      { ...target, state: "up-to-date", branch: "main" },
      { ...target, state: "skipped", reason: "dirty", message: "main jest wybrana i ma niezacommitowane zmiany" },
      { ...target, state: "failed", message: "Permission denied (publickey)." },
    ];
    expect(repos.map(syncRepoTone)).toEqual([
      { tone: "warning", label: "czeka" },
      { tone: "warning", label: "synchronizuję…" },
      { tone: "ok", label: "+1 commit" },
      { tone: "ok", label: "+3 commity" },
      { tone: "ok", label: "+12 commitów" },
      { tone: "ok", label: "aktualne" },
      { tone: "warning", label: "pominięte: zmiany lokalne" },
      { tone: "error", label: "błąd synchronizacji" },
    ]);
  });

  test("postęp liczy repo z wynikiem, a osobno przesunięte, pominięte i nieudane", () => {
    const run = {
      startedAt: "2026-10-23T10:00:00Z",
      finishedAt: null,
      repos: [
        { ...target, state: "running" },
        { ...target, state: "waiting" },
        { ...target, state: "updated", branch: "main", commits: 2 },
        { ...target, state: "up-to-date", branch: "main" },
        { ...target, state: "skipped", reason: "ahead", message: "x" },
        { ...target, state: "failed", message: "x" },
      ],
    } satisfies { startedAt: string; finishedAt: null; repos: SyncRepo[] };
    expect(syncProgress(run)).toEqual({ done: 4, total: 6, updated: 1, skipped: 1, failed: 1 });
  });

  test("na liście repo wynik ma zdanie z daemona, a aktualne repo nie ma wyniku", () => {
    expect(listSyncBadge(undefined)).toBeUndefined();
    expect(listSyncBadge({ ...target, state: "up-to-date", branch: "main" })).toBeUndefined();
    expect(listSyncBadge({ ...target, state: "failed", message: "Permission denied (publickey)." })).toEqual({
      tone: "error",
      label: "błąd synchronizacji",
      message: "Permission denied (publickey).",
    });
    expect(listSyncBadge({ ...target, state: "updated", branch: "main", commits: 2 })).toEqual({
      tone: "ok",
      label: "+2 commity",
      message: undefined,
    });
  });
});
