import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { WorktreeChanges } from "@trackwall/protocol";
import { git, revParse } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { parseChangedFiles, parseStatus } from "./parse.ts";

/**
 * Worktree zadań agentów (§4.4, ADR-31): gałąź zadania w osobnym katalogu roboczym obok repo, jej zmiany względem
 * commita bazowego i usunięcie. Funkcje dostają katalogi; które repo i który worktree, wie moduł `agents`.
 */

/** `worktree add` wypełnia katalog roboczy, a filtr LFS może przy tym pobierać obiekty. */
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;
/** `add --all` do indeksu tymczasowego liczy skróty nowych plików; duże wygenerowane pliki trwają. */
const CHANGES_TIMEOUT_MS = 60_000;

/** Skąd zadanie wychodzi: gałąź domyślna repo (albo wybrana, gdy domyślnej nie ma) i jej commit. */
export interface WorktreeBase {
  branch: string | null;
  commit: string;
}

/**
 * Gałąź domyślna bez pytania serwera: z `refs/remotes/<remote>/HEAD`, lokalna, gdy istnieje (to ją przesuwa
 * synchronizacja, ADR-21, i na niej mogą leżeć niewypchnięte commity), inaczej zdalna. Repo bez remote albo bez
 * wskazania gałęzi domyślnej daje gałąź wybraną w repo, a odłączony HEAD sam commit.
 */
export async function defaultBase(dir: string): Promise<WorktreeBase> {
  const remote = mainRemote(await readConfig(dir));
  const prefix = remote && `refs/remotes/${remote.name}/`;
  const remoteHead = prefix ? await symbolicRef(dir, `${prefix}HEAD`) : undefined;
  if (prefix && remoteHead?.startsWith(prefix)) {
    const branch = remoteHead.slice(prefix.length);
    const commit = (await revParse(dir, `refs/heads/${branch}`)) ?? (await revParse(dir, remoteHead));
    if (commit) return { branch, commit };
  }
  const head = await revParse(dir, "HEAD");
  if (!head) throw new Error("repo nie ma jeszcze commitów");
  const current = await symbolicRef(dir, "HEAD");
  return { branch: current?.startsWith("refs/heads/") ? current.slice("refs/heads/".length) : null, commit: head };
}

async function symbolicRef(dir: string, ref: string): Promise<string | undefined> {
  return git(dir, ["symbolic-ref", "--quiet", ref]).then(
    ({ stdout }) => stdout.toString("utf8").trim() || undefined,
    () => undefined,
  );
}

/** Nowa gałąź `branch` od `commit` i jej worktree w `path`; git odmawia, gdy gałąź albo katalog już istnieją. */
export async function addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void> {
  await git(repoDir, ["worktree", "add", "--quiet", "-b", branch, path, commit], { timeoutMs: CHECKOUT_TIMEOUT_MS });
}

/**
 * Usuwa worktree razem z niezacommitowanymi zmianami (`--force`): wołający sprawdził `pendingWork` albo użytkownik
 * potwierdził utratę. Katalog, którego już nie ma (usunięty ręcznie), znika tylko z rejestru worktree w repo.
 */
export async function removeWorktree(repoDir: string, path: string): Promise<void> {
  if (!existsSync(path)) {
    await git(repoDir, ["worktree", "prune"]);
    return;
  }
  await git(repoDir, ["worktree", "remove", "--force", path], { timeoutMs: CHECKOUT_TIMEOUT_MS });
}

/** Usuwa gałąź niezależnie od tego, czy jest scalona; gałęzi, której już nie ma, nie ma czego usuwać. */
export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  if ((await revParse(repoDir, `refs/heads/${branch}`)) === undefined) return;
  await git(repoDir, ["branch", "--quiet", "-D", branch]);
}

/** Gałąź w worktree: repo z gałęzią, katalog worktree i commit, od którego gałąź wyszła. */
export interface WorktreeBranch {
  repoDir: string;
  worktree: string;
  branch: string;
  base: string;
}

/**
 * Co przepadłoby przy usunięciu zadania: wpisy `git status` worktree (każdy nowy plik osobno; worktree usunięty
 * ręcznie nie ma żadnych) i commity gałęzi zadania od `base` (gałęzi usuniętej ręcznie nie ma czego liczyć).
 */
export async function pendingWork(work: WorktreeBranch): Promise<{ uncommitted: number; commits: number }> {
  const branchRef = `refs/heads/${work.branch}`;
  const [uncommitted, commits] = await Promise.all([
    existsSync(work.worktree) ? uncommittedCount(work.worktree) : 0,
    revParse(work.repoDir, branchRef).then((tip) => (tip ? commitCount(work.repoDir, work.base, branchRef) : 0)),
  ]);
  return { uncommitted, commits };
}

async function uncommittedCount(dir: string): Promise<number> {
  const { stdout } = await git(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  return parseStatus(stdout.toString("utf8")).changes;
}

async function commitCount(dir: string, from: string, to: string): Promise<number> {
  const { stdout } = await git(dir, ["rev-list", "--count", `${from}..${to}`]);
  return Number(stdout.toString("utf8").trim());
}

/**
 * Katalog roboczy względem `base`, z nowymi plikami i bez ignorowanych. Nowe pliki trafiają do indeksu tymczasowego
 * (kopia indeksu worktree, żeby git nie liczył od nowa skrótów niezmienionych plików), więc indeks, którego używa
 * agent, zostaje nietknięty. Diff bez zewnętrznych programów diff i `textconv` z konfiguracji repo.
 */
export async function worktreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<WorktreeChanges> {
  const index = resolve(dir, (await git(dir, ["rev-parse", "--git-path", "index"])).stdout.toString("utf8").trim());
  const tmp = resolve(tmpdir(), `trackwall-index-${randomUUID()}`);
  try {
    await copyFile(index, tmp).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    // Plik trzymany przez działający proces (Windows) nie zatrzymuje reszty.
    await git(dir, ["add", "--all", "--ignore-errors", "--", "."], { indexFile: tmp, timeoutMs: CHANGES_TIMEOUT_MS });
    const diff = (args: string[], maxBytes?: number) =>
      git(dir, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", ...args, base, "--"], {
        indexFile: tmp,
        timeoutMs: CHANGES_TIMEOUT_MS,
        maxBytes,
      });
    const [names, stats, patch, commits, uncommitted] = await Promise.all([
      diff(["--name-status", "-z"]),
      diff(["--numstat", "-z"]),
      diff([], maxPatchBytes),
      commitCount(dir, base, "HEAD"),
      uncommittedCount(dir),
    ]);
    return {
      files: parseChangedFiles(names.stdout.toString("utf8"), stats.stdout.toString("utf8")),
      patch: patch.stdout.toString("utf8"),
      truncated: patch.truncated,
      commits,
      uncommitted,
    };
  } finally {
    await rm(tmp, { force: true });
  }
}
