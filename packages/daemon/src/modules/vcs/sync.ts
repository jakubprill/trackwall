import { countLabel, type SyncResult, type SyncSkipReason } from "@trackwall/protocol";
import { type GitNetwork, git, knownDefaultBranch, revParse } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { parseStatus } from "./parse.ts";

/**
 * Synchronizacja jednego repo (§4.5, ADR-21): `git fetch` głównego remote, potem fast-forward lokalnej gałęzi
 * domyślnej do zdalnej, i nic poza tym. Nie scala, nie robi rebase, nie przełącza gałęzi i nie dotyka katalogu
 * roboczego, w którym są zmiany; każdy taki przypadek to pominięcie z powodem, a błąd gita to wyjątek.
 */

/**
 * Fetch dużego repo przez VPN trwa minutami; dłużej to raczej zawieszone połączenie. Zabicie gita po limicie nie
 * psuje repo: fetch zapisuje refy dopiero na końcu.
 */
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** Fast-forward wybranej gałęzi aktualizuje pliki w katalogu roboczym; duże repo z LFS pobiera przy tym obiekty. */
const MERGE_TIMEOUT_MS = 5 * 60_000;

export async function syncRepo(dir: string): Promise<SyncResult> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) return skipped("no-remote", "the repo has neither an origin remote nor a single other remote");
  const network = { sshCommand: config.sshCommand };
  await git(dir, ["fetch", "--quiet", "--", remote.name], { timeoutMs: FETCH_TIMEOUT_MS, network });
  const branch = await defaultBranch(dir, remote.name, network);
  if (branch === undefined)
    return skipped("no-default-branch", `${remote.name} does not point to a default branch (git remote set-head ${remote.name} --auto)`);
  return fastForward(dir, branch, `refs/remotes/${remote.name}/${branch}`, network);
}

/**
 * Gałąź domyślna zdalnego repo z `refs/remotes/<remote>/HEAD`, który ustawia `git clone`. Gdy go nie ma (repo
 * z `git init` i `remote add`) albo wskazuje gałąź, której już nie ma (hosting zmienił gałąź domyślną, a fetch
 * z `prune` usunął starą), jedno pytanie do serwera (`remote set-head --auto`). Zmiany gałęzi domyślnej, której
 * stara wersja nadal istnieje, daemon nie wykryje bez pytania serwera przy każdej synchronizacji.
 */
async function defaultBranch(dir: string, remote: string, network: GitNetwork): Promise<string | undefined> {
  const read = () => knownDefaultBranch(dir, remote);
  const known = await read();
  if (known !== undefined) return known;
  try {
    await git(dir, ["remote", "set-head", "--auto", "--", remote], {
      timeoutMs: FETCH_TIMEOUT_MS,
      network,
    });
  } catch {
    return undefined;
  }
  return read();
}

async function fastForward(dir: string, branch: string, remoteRef: string, network: GitNetwork): Promise<SyncResult> {
  const localRef = `refs/heads/${branch}`;
  if ((await revParse(dir, localRef)) === undefined)
    return skipped("no-local-branch", `branch ${branch} does not exist locally; only fetched the changes`);
  const { ahead, behind } = await divergence(dir, localRef, remoteRef);
  if (ahead > 0 && behind > 0)
    return skipped("diverged", `${branch} has diverged from the remote (${ahead} local, ${behind} remote); merge by hand`);
  if (ahead > 0) return skipped("ahead", `${branch} has ${countLabel(ahead, { one: "unpushed commit", other: "unpushed commits" })}`);
  if (behind === 0) return { state: "up-to-date", branch };

  const status = parseStatus(
    (await git(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"])).stdout.toString("utf8"),
  );
  if (status.branch === branch) {
    if (status.changes > 0) return skipped("dirty", `${branch} is checked out and has uncommitted changes`);
    // Przesunięcie wybranej gałęzi musi też zaktualizować katalog roboczy; `--ff-only` odmówi, zamiast nadpisać
    // nieśledzony plik, który leży na drodze. Filtr LFS może przy tym pobierać obiekty, stąd środowisko sieciowe.
    await git(dir, ["merge", "--ff-only", "--quiet", remoteRef], {
      timeoutMs: MERGE_TIMEOUT_MS,
      network,
    });
  } else {
    if (await checkedOutInWorktree(dir, localRef))
      return skipped("checked-out-elsewhere", `${branch} is checked out in another worktree of this repo`);
    // Fetch z bieżącego repo bez `+` przyjmuje tylko fast-forward i odmawia, gdy gałąź jest w użyciu w którymś
    // worktree także bez bycia wybraną (rebase albo bisect w toku), czego nie widać w `worktree list`. Bez
    // submodułów (`submodule.recurse` użytkownika pobierałby je drugi raz z sieci) i bez nadpisania `FETCH_HEAD`.
    await git(dir, ["fetch", "--quiet", "--no-recurse-submodules", "--no-write-fetch-head", ".", `${remoteRef}:${localRef}`]);
  }
  return { state: "updated", branch, commits: behind };
}

/** Ile commitów ma tylko lokalna gałąź (`ahead`), a ile tylko zdalna (`behind`). */
async function divergence(dir: string, localRef: string, remoteRef: string): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await git(dir, ["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`]);
  const m = /^(\d+)\s+(\d+)/.exec(stdout.toString("utf8").trim());
  if (!m) throw new Error(`unexpected git rev-list output: ${stdout.toString("utf8").trim()}`);
  return { ahead: Number(m[1]), behind: Number(m[2]) };
}

/**
 * Czy gałąź jest wybrana w którymś worktree; wołane, gdy w bieżącym nie jest, więc chodzi o inny worktree. Linie
 * zamiast `-z`, które git ma dopiero od 2.36.
 */
async function checkedOutInWorktree(dir: string, localRef: string): Promise<boolean> {
  const { stdout } = await git(dir, ["worktree", "list", "--porcelain"]);
  return stdout
    .toString("utf8")
    .split("\n")
    .some((line) => line === `branch ${localRef}`);
}

function skipped(reason: SyncSkipReason, message: string): SyncResult {
  return { state: "skipped", reason, message };
}
