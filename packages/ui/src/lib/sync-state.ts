import { countLabel, type SyncRepo, type SyncRun, type SyncSkipReason, type SyncWorkingTree } from "@trackwall/protocol";
import { workingTreeLabel } from "./format.ts";
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

/**
 * Pełne zdania o wyniku repo (ADR-34): co stało się z gałęzią domyślną, czy zmieniło to pliki w katalogu roboczym
 * (nie, gdy wybrana jest inna gałąź) i że lokalne zmiany zostały nietknięte. Bez tego „aktualne” repo z czterema
 * zmienionymi plikami wygląda jak synchronizacja, która nic nie zrobiła. Trwające repo nie ma jeszcze czego powiedzieć.
 */
export function syncMessage(repo: SyncRepo): string | undefined {
  switch (repo.state) {
    case "waiting":
    case "running":
      return undefined;
    case "failed":
      return repo.message;
    case "updated":
      return sentences([
        `${repo.branch} moved ${countLabel(repo.commits, { one: "commit", other: "commits" })} forward to ${repo.remoteBranch}`,
        repo.workingTree.branch === repo.branch
          ? "Files in the working directory were updated"
          : `${checkedOut(repo.workingTree)}, so files in the working directory did not change`,
        localChanges(repo.workingTree),
      ]);
    case "up-to-date":
      return sentences([
        `${repo.branch} already matches ${repo.remoteBranch}`,
        repo.workingTree.branch === repo.branch ? undefined : `${checkedOut(repo.workingTree)}; sync only moves ${repo.branch}`,
        localChanges(repo.workingTree),
      ]);
    case "skipped":
      return sentences([repo.message, localChanges(repo.workingTree)]);
  }
}

function checkedOut(tree: SyncWorkingTree): string {
  return tree.branch === null ? "The working directory has a detached HEAD" : `The working directory is on ${tree.branch}`;
}

function localChanges(tree: SyncWorkingTree): string | undefined {
  const label = workingTreeLabel(tree.changed, tree.untracked);
  return label && `Uncommitted files stay as they are: ${label}`;
}

function sentences(parts: (string | undefined)[]): string {
  return parts
    .filter((p) => p !== undefined)
    .map((p) => (p.endsWith(".") ? p : `${p}.`))
    .join(" ");
}

/** Wynik pod stanem repo na liście, także „aktualne”, bo bez niego nie widać, że synchronizacja doszła do repo. */
export function listSyncBadge(repo: SyncRepo | undefined): { tone: StatusTone; label: string; message: string | undefined } | undefined {
  if (!repo) return undefined;
  return { ...syncRepoTone(repo), message: syncMessage(repo) };
}

export interface SyncProgress {
  /** Repo z wynikiem (także pominięte i nieudane). */
  done: number;
  total: number;
  updated: number;
  upToDate: number;
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
    upToDate: count("up-to-date"),
    skipped: count("skipped"),
    failed: count("failed"),
  };
}

/** Wynik repo po ścieżce, nie po identyfikatorze: ten może się zmienić razem z nazwą katalogu (ADR-18). */
export function syncedByPath(run: SyncRun | null | undefined): ReadonlyMap<string, SyncRepo> {
  return new Map((run?.repos ?? []).map((r) => [r.path, r]));
}
