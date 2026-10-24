import type { SyncRepo, SyncRun, SyncSkipReason } from "@trackwall/protocol";
import { countLabel } from "./format.ts";
import type { StatusTone } from "./repo-status.ts";

/** Synchronizacja w UI (ADR-21): ton i krótki tekst wyniku repo oraz postęp całości; testy w `test/sync-state.test.ts`. */

/** Krótko, bo stoi w wierszu listy repo; pełne zdanie z daemona jest w panelu synchronizacji. */
const SKIP_LABEL: Record<SyncSkipReason, string> = {
  "no-remote": "no remote",
  "no-default-branch": "no default branch",
  "no-local-branch": "no local branch",
  dirty: "local changes",
  diverged: "diverged branch",
  ahead: "unpushed commits",
  "checked-out-elsewhere": "in another worktree",
};

export function syncRepoTone(repo: SyncRepo): { tone: StatusTone; label: string } {
  switch (repo.state) {
    case "waiting":
      return { tone: "warning", label: "waiting" };
    case "running":
      return { tone: "warning", label: "syncing…" };
    case "updated":
      return { tone: "ok", label: `+${countLabel(repo.commits, { one: "commit", other: "commits" })}` };
    case "up-to-date":
      return { tone: "ok", label: "up to date" };
    case "skipped":
      return { tone: "warning", label: `skipped: ${SKIP_LABEL[repo.reason]}` };
    case "failed":
      return { tone: "error", label: "sync failed" };
  }
}

/** Zdanie z daemona dla pominiętego albo nieudanego repo; reszta wyników mieści się w krótkim tekście. */
export function syncMessage(repo: SyncRepo): string | undefined {
  return repo.state === "skipped" || repo.state === "failed" ? repo.message : undefined;
}

/**
 * Wynik pod stanem repo na liście, chyba że repo było już aktualne: wtedy nie ma o czym mówić, a stary napis
 * „aktualne” byłby z czasem nieprawdą.
 */
export function listSyncBadge(repo: SyncRepo | undefined): { tone: StatusTone; label: string; message: string | undefined } | undefined {
  if (!repo || repo.state === "up-to-date") return undefined;
  return { ...syncRepoTone(repo), message: syncMessage(repo) };
}

export interface SyncProgress {
  /** Repo z wynikiem (także pominięte i nieudane). */
  done: number;
  total: number;
  updated: number;
  skipped: number;
  failed: number;
}

export function syncProgress(run: SyncRun): SyncProgress {
  const count = (state: SyncRepo["state"]) => run.repos.filter((r) => r.state === state).length;
  const pending = count("waiting") + count("running");
  return {
    done: run.repos.length - pending,
    total: run.repos.length,
    updated: count("updated"),
    skipped: count("skipped"),
    failed: count("failed"),
  };
}

/** Wynik repo po ścieżce, nie po identyfikatorze: ten może się zmienić razem z nazwą katalogu (ADR-18). */
export function syncedByPath(run: SyncRun | null | undefined): ReadonlyMap<string, SyncRepo> {
  return new Map((run?.repos ?? []).map((r) => [r.path, r]));
}
