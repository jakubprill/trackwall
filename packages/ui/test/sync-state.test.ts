import { describe, expect, test } from "bun:test";
import type { SyncRepo } from "@trackwall/protocol";
import { listSyncBadge, syncMessage, syncProgress, syncRepoTone } from "../src/lib/sync-state.ts";

const target = { repo: "api", path: "/projekty/api" };
const onMain = { branch: "main", changed: 0, untracked: 0 };
const ff = { branch: "main", remoteBranch: "origin/main" };

describe("synchronizacja w UI", () => {
  test("wynik repo ma ton i krótki tekst: trwające i pominięte ostrzegają, nieudane to błąd", () => {
    const repos: SyncRepo[] = [
      { ...target, state: "waiting" },
      { ...target, state: "running" },
      { ...target, state: "updated", ...ff, commits: 1, workingTree: onMain },
      { ...target, state: "updated", ...ff, commits: 3, workingTree: onMain },
      { ...target, state: "updated", ...ff, commits: 12, workingTree: onMain },
      { ...target, state: "up-to-date", ...ff, workingTree: onMain },
      { ...target, state: "skipped", reason: "dirty", message: "main is checked out and has uncommitted changes", workingTree: onMain },
      { ...target, state: "failed", message: "Permission denied (publickey)." },
    ];
    expect(repos.map(syncRepoTone)).toEqual([
      { tone: "warning", label: "waiting" },
      { tone: "warning", label: "syncing…" },
      { tone: "ok", label: "+1 commit" },
      { tone: "ok", label: "+3 commits" },
      { tone: "ok", label: "+12 commits" },
      { tone: "ok", label: "up to date" },
      { tone: "warning", label: "skipped: local changes" },
      { tone: "error", label: "sync failed" },
    ]);
  });

  test("postęp liczy repo z wynikiem, a osobno przesunięte, aktualne, pominięte i nieudane", () => {
    const run = {
      startedAt: "2026-10-23T10:00:00Z",
      finishedAt: null,
      repos: [
        { ...target, state: "running" },
        { ...target, state: "waiting" },
        { ...target, state: "updated", ...ff, commits: 2, workingTree: onMain },
        { ...target, state: "up-to-date", ...ff, workingTree: onMain },
        { ...target, state: "skipped", reason: "ahead", message: "x", workingTree: onMain },
        { ...target, state: "failed", message: "x" },
      ],
    } satisfies { startedAt: string; finishedAt: null; repos: SyncRepo[] };
    expect(syncProgress(run)).toEqual({ done: 4, total: 6, updated: 1, upToDate: 1, skipped: 1, failed: 1 });
  });

  test("zdanie wyniku mówi, co stało się z gałęzią domyślną, czy pliki się zmieniły i co zostało niezacommitowane", () => {
    expect(syncMessage({ ...target, state: "running" })).toBeUndefined();
    expect(syncMessage({ ...target, state: "updated", ...ff, commits: 2, workingTree: onMain })).toBe(
      "main moved 2 commits forward to origin/main. Files in the working directory were updated.",
    );
    expect(
      syncMessage({ ...target, state: "updated", ...ff, commits: 1, workingTree: { branch: "funkcja", changed: 2, untracked: 0 } }),
    ).toBe(
      "main moved 1 commit forward to origin/main. The working directory is on funkcja, so files in the working directory did not change. Uncommitted files stay as they are: 2 changed.",
    );
    expect(syncMessage({ ...target, state: "up-to-date", ...ff, workingTree: { branch: "main", changed: 3, untracked: 1 } })).toBe(
      "main already matches origin/main. Uncommitted files stay as they are: 3 changed, 1 new.",
    );
    expect(syncMessage({ ...target, state: "up-to-date", ...ff, workingTree: { branch: null, changed: 0, untracked: 0 } })).toBe(
      "main already matches origin/main. The working directory has a detached HEAD; sync only moves main.",
    );
    expect(
      syncMessage({
        ...target,
        state: "skipped",
        reason: "dirty",
        message: "main is checked out and has uncommitted changes",
        workingTree: { branch: "main", changed: 1, untracked: 0 },
      }),
    ).toBe("main is checked out and has uncommitted changes. Uncommitted files stay as they are: 1 changed.");
    expect(syncMessage({ ...target, state: "up-to-date", ...ff, workingTree: null })).toBe("main already matches origin/main.");
    expect(syncMessage({ ...target, state: "failed", message: "Permission denied (publickey)." })).toBe("Permission denied (publickey).");
  });

  test("na liście repo każdy wynik ma krótki tekst i pełne zdanie z czasem synchronizacji, także aktualne repo", () => {
    expect(listSyncBadge(undefined, "5 min ago")).toBeUndefined();
    expect(listSyncBadge({ ...target, state: "up-to-date", ...ff, workingTree: onMain }, "5 min ago")).toEqual({
      tone: "ok",
      label: "up to date",
      message: "main already matches origin/main. Synced 5 min ago.",
    });
    expect(listSyncBadge({ ...target, state: "failed", message: "Permission denied (publickey)." }, "just now")).toEqual({
      tone: "error",
      label: "sync failed",
      message: "Permission denied (publickey). Synced just now.",
    });
  });
});
