import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { git, knownDefaultBranch, revParse, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { parseStatus } from "./parse.ts";
import { pathKey } from "./path-key.ts";

/**
 * Worktree zadań agentów (§4.4, ADR-31): gałąź zadania w osobnym katalogu roboczym (w katalogu stanu daemona),
 * od czego wychodzi, co przepadłoby przy jej usunięciu i samo usunięcie. Funkcje dostają katalogi; które repo
 * i który worktree, wie moduł `agents`. Zmiany worktree liczy `worktree-changes.ts`.
 */

/** `worktree add` wypełnia katalog roboczy, a filtr LFS może przy tym pobierać obiekty. */
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;

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
  const branch = remote ? await knownDefaultBranch(dir, remote.name) : undefined;
  if (remote && branch) {
    const commit = (await revParse(dir, `refs/heads/${branch}`)) ?? (await revParse(dir, `refs/remotes/${remote.name}/${branch}`));
    if (commit) return { branch, commit };
  }
  const head = await revParse(dir, "HEAD");
  if (!head) throw new Error("repo nie ma jeszcze commitów");
  const current = await symbolicRef(dir, "HEAD");
  return { branch: current?.startsWith("refs/heads/") ? current.slice("refs/heads/".length) : null, commit: head };
}

/** Nowa gałąź `branch` od `commit` i jej worktree w `path`; git odmawia, gdy gałąź albo katalog już istnieją. */
export async function addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void> {
  await git(repoDir, ["worktree", "add", "--quiet", "-b", branch, path, commit], { timeoutMs: CHECKOUT_TIMEOUT_MS });
}

/**
 * Usuwa worktree razem z niezacommitowanymi i ignorowanymi plikami (`--force`): wołający sprawdził `pendingWork`
 * albo użytkownik potwierdził utratę. Git zdejmuje rejestrację worktree przed kasowaniem plików, więc usunięcie
 * przerwane przez plik trzymany przez inny proces (Windows) zostawia katalog, który nie jest już worktree; taki
 * katalog, tak jak każdy niezarejestrowany (`pendingWork` go zgłasza), kasujemy sami, a rejestrację po katalogu
 * usuniętym ręcznie czyści `prune`.
 * `path` musi leżeć w katalogu worktree daemona, bo jest kasowany bez pytania gita.
 */
export async function removeWorktree(repoDir: string, path: string): Promise<void> {
  if (existsSync(path) && (await isRegistered(repoDir, path))) {
    try {
      await git(repoDir, ["worktree", "remove", "--force", path], { timeoutMs: CHECKOUT_TIMEOUT_MS });
    } catch (err) {
      if (await isRegistered(repoDir, path)) throw err;
    }
  }
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
  await git(repoDir, ["worktree", "prune"]);
}

/** Czy `path` jest worktree repo według `git worktree list`. */
async function isRegistered(repoDir: string, path: string): Promise<boolean> {
  const { stdout } = await git(repoDir, ["worktree", "list", "--porcelain"]);
  const target = await pathKey(path);
  const listed = stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  for (const line of listed) if ((await pathKey(line.slice("worktree ".length))) === target) return true;
  return false;
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

/** Co przepadłoby przy usunięciu worktree, a bez gałęzi także przy usunięciu gałęzi. */
export interface PendingWork {
  /** Wpisy `git status` worktree, każdy nowy plik osobno. */
  uncommitted: number;
  /** Commity HEAD worktree, których nie ma na żadnej gałęzi ani tagu (odłączony HEAD): znikają razem z worktree. */
  strayCommits: number;
  /** Commity gałęzi od `base`. */
  branchCommits: number;
  /**
   * Katalog worktree jest na dysku, ale git go nie zna (przerwane usuwanie, `worktree prune`, repo sklonowane od
   * nowa), więc nie da się policzyć, co w nim jest; usunięcie skasuje go w całości.
   */
  unregisteredDir: boolean;
}

/** Worktree usunięty ręcznie nie ma czego stracić; gałąź usunięta ręcznie też nie. */
export async function pendingWork(work: WorktreeBranch): Promise<PendingWork> {
  const branchRef = `refs/heads/${work.branch}`;
  const onDisk = existsSync(work.worktree);
  const registered = onDisk && (await isRegistered(work.repoDir, work.worktree));
  const [uncommitted, strayCommits, branchCommits] = await Promise.all([
    registered ? uncommittedCount(work.worktree) : 0,
    registered ? count(work.worktree, ["HEAD", "--not", "--branches", "--tags", "--remotes"]) : 0,
    revParse(work.repoDir, branchRef).then((tip) => (tip ? commitCount(work.repoDir, work.base, branchRef) : 0)),
  ]);
  return { uncommitted, strayCommits, branchCommits, unregisteredDir: onDisk && !registered };
}

export async function uncommittedCount(dir: string): Promise<number> {
  const { stdout } = await git(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  return parseStatus(stdout.toString("utf8")).changes;
}

export function commitCount(dir: string, from: string, to: string): Promise<number> {
  return count(dir, [`${from}..${to}`]);
}

async function count(dir: string, revs: string[]): Promise<number> {
  const { stdout } = await git(dir, ["rev-list", "--count", ...revs, "--"]);
  return Number(stdout.toString("utf8").trim());
}
