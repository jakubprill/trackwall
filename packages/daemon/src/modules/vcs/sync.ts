import type { SyncOutcome, SyncSkipReason } from "@trackwall/protocol";
import { git } from "./git.ts";
import { parseStatus } from "./parse.ts";
import { type GitConfig, mainRemote, parseConfig } from "./remote.ts";

/**
 * Synchronizacja jednego repo (§4.5, ADR-21): `git fetch` głównego remote, potem fast-forward lokalnej gałęzi
 * domyślnej do zdalnej, i nic poza tym. Nie scala, nie robi rebase, nie przełącza gałęzi i nie dotyka katalogu
 * roboczego, w którym są zmiany; każdy taki przypadek kończy się pominięciem z powodem.
 */

/**
 * Fetch dużego repo przez VPN trwa minutami; dłużej to raczej zawieszone połączenie. Zabicie gita po limicie nie
 * psuje repo: fetch zapisuje refy dopiero na końcu.
 */
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** Fast-forward wybranej gałęzi aktualizuje pliki w katalogu roboczym; duże repo z LFS potrzebuje chwili. */
const MERGE_TIMEOUT_MS = 2 * 60_000;

export async function syncRepo(dir: string): Promise<SyncOutcome> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) return skipped("no-remote", "repo nie ma remote origin");
  await git(dir, ["fetch", "--quiet", "--", remote.name], { timeoutMs: FETCH_TIMEOUT_MS, env: noPromptEnv(config) });
  const branch = await defaultBranch(dir, remote.name, config);
  if (branch === undefined)
    return skipped("no-default-branch", `${remote.name} nie wskazuje gałęzi domyślnej (git remote set-head ${remote.name} --auto)`);
  return fastForward(dir, branch, `refs/remotes/${remote.name}/${branch}`);
}

export async function readConfig(dir: string): Promise<GitConfig> {
  const { stdout } = await git(dir, ["config", "-z", "--list"]);
  return parseConfig(stdout.toString("utf8"));
}

/**
 * Środowisko komend sieciowych: daemon nie ma terminala ani okna, więc każde pytanie o hasło, token albo klucz
 * hosta wisiałoby do limitu czasu w ukrytej konsoli. `GIT_TERMINAL_PROMPT=0` jest już w `gitEnv()`; tu dochodzi
 * pusty `GIT_ASKPASS` (git nie pyta wtedy przez program, także odziedziczony z terminala VS Code), Git Credential
 * Manager bez okien i ssh w trybie wsadowym, chyba że użytkownik sam ustawił program ssh: wtedy zostaje jego.
 */
export function noPromptEnv(config: GitConfig, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_ASKPASS: "", GCM_INTERACTIVE: "never" };
  const userSsh = inherited.GIT_SSH_COMMAND || inherited.GIT_SSH || config.sshCommand;
  if (!userSsh) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/**
 * Gałąź domyślna zdalnego repo z `refs/remotes/<remote>/HEAD`, który ustawia `git clone`. Repo założone przez
 * `git init` i `remote add` go nie ma, więc wtedy jedno pytanie do serwera (`remote set-head --auto`).
 */
async function defaultBranch(dir: string, remote: string, config: GitConfig): Promise<string | undefined> {
  const prefix = `refs/remotes/${remote}/`;
  const read = async () => {
    const ref = await git(dir, ["symbolic-ref", "--quiet", `${prefix}HEAD`]).then(
      ({ stdout }) => stdout.toString("utf8").trim(),
      () => "",
    );
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
  };
  const known = await read();
  if (known !== undefined) return known;
  try {
    await git(dir, ["remote", "set-head", "--auto", "--", remote], { timeoutMs: FETCH_TIMEOUT_MS, env: noPromptEnv(config) });
  } catch {
    return undefined;
  }
  return read();
}

async function fastForward(dir: string, branch: string, remoteRef: string): Promise<SyncOutcome> {
  const localRef = `refs/heads/${branch}`;
  const local = await revParse(dir, localRef);
  if (local === undefined) return skipped("no-local-branch", `gałęzi ${branch} nie ma lokalnie; pobrano tylko zmiany`);
  const { ahead, behind } = await divergence(dir, localRef, remoteRef);
  if (ahead > 0 && behind > 0)
    return skipped("diverged", `${branch} rozjechała się ze zdalną (${ahead} lokalnych, ${behind} zdalnych); scal ręcznie`);
  if (ahead > 0) return skipped("ahead", `${branch} ma ${ahead} niewypchniętych commitów`);
  if (behind === 0) return { state: "up-to-date", branch };

  const status = parseStatus(
    (await git(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"])).stdout.toString("utf8"),
  );
  if (status.branch === branch) {
    if (status.changes > 0) return skipped("dirty", `${branch} jest wybrana i ma niezacommitowane zmiany`);
    // Merge, a nie `update-ref`, bo przesunięcie wybranej gałęzi musi też zaktualizować katalog roboczy;
    // `--ff-only` odmówi, zamiast nadpisać nieśledzony plik, który leży na drodze.
    await git(dir, ["merge", "--ff-only", "--quiet", remoteRef], { timeoutMs: MERGE_TIMEOUT_MS });
  } else {
    if (await checkedOutInWorktree(dir, localRef))
      return skipped("checked-out-elsewhere", `${branch} jest wybrana w innym worktree tego repo`);
    const target = await revParse(dir, remoteRef);
    if (target === undefined) throw new Error(`nie ma ${remoteRef} po fetch`);
    // Stara wartość w `update-ref` sprawia, że commit zrobiony w międzyczasie nie zostanie po cichu nadpisany.
    await git(dir, ["update-ref", "-m", `trackwall sync: fast-forward do ${remoteRef}`, localRef, target, local]);
  }
  return { state: "updated", branch, commits: behind };
}

async function revParse(dir: string, ref: string): Promise<string | undefined> {
  return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
    ({ stdout }) => stdout.toString("utf8").trim(),
    () => undefined,
  );
}

/** Ile commitów ma tylko lokalna gałąź (`ahead`), a ile tylko zdalna (`behind`). */
async function divergence(dir: string, localRef: string, remoteRef: string): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await git(dir, ["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`]);
  const m = /^(\d+)\s+(\d+)/.exec(stdout.toString("utf8").trim());
  if (!m) throw new Error(`nieoczekiwany wynik git rev-list: ${stdout.toString("utf8").trim()}`);
  return { ahead: Number(m[1]), behind: Number(m[2]) };
}

/** Czy gałąź jest wybrana w którymś worktree; wołane, gdy w bieżącym nie jest, więc chodzi o inny worktree. */
async function checkedOutInWorktree(dir: string, localRef: string): Promise<boolean> {
  const { stdout } = await git(dir, ["worktree", "list", "--porcelain", "-z"]);
  return stdout
    .toString("utf8")
    .split("\0")
    .some((field) => field === `branch ${localRef}`);
}

function skipped(reason: SyncSkipReason, message: string): SyncOutcome {
  return { state: "skipped", reason, message };
}
