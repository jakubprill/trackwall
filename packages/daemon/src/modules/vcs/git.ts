import { realpath } from "node:fs/promises";
import { delimiter, dirname, resolve as resolvePath } from "node:path";
import { type RunOptions, type RunOutput, runProgram } from "./run.ts";

/**
 * Uruchamianie `git` dla modułu `vcs`. Argumenty zawsze tablicą, bez powłoki; katalog repo przez `-C`,
 * żeby brak katalogu był błędem gita z czytelnym komunikatem, a nie `ENOENT` mylony z brakiem gita.
 * `repoDir` to zawsze korzeń repo, a repo trafia na listę samo, gdy leży w folderze z projektami (ADR-18), więc
 * git nie może szukać repo powyżej niego, a klucze z `NO_REPO_COMMANDS` są wyłączone; reszta konfiguracji repo
 * obowiązuje (luki z filtrem `clean` i z programami z konfiguracji repo przy synchronizacji w §8).
 */

/**
 * Klucze `.git/config`, którymi repo kazałoby gitowi uruchomić program przy komendach daemona:
 * `core.fsmonitor` przy `status`, `log.showSignature` (z `gpg.program`) przy `log`.
 */
const NO_REPO_COMMANDS = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];

/**
 * Na Windowsie ścieżki ponad 260 znaków tylko z `core.longpaths`: worktree zadań leżą w katalogu stanu (ADR-31), więc
 * ścieżki plików repo są w nich dłuższe niż w folderze z projektami. Klucz nie zmienia niczego poza Windowsem.
 */
const PLATFORM_CONFIG = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

/** Zwykłe wywołania kończą się w ułamku sekundy; limit chroni przed wiszącym gitem (blokada, dysk sieciowy). */
const TIMEOUT_MS = 15_000;

/**
 * Zmienne, którymi git wybiera repo zamiast `-C`. Odziedziczone (daemon uruchomiony z hooka gita albo z powłoki
 * z `GIT_DIR`) sprawiłyby, że każde repo z listy pokazuje dane jednego.
 */
const REPO_SELECTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

type GitOptions = Pick<RunOptions, "maxBytes" | "stdin"> & {
  /** Limit dłuższy niż `TIMEOUT_MS` dla komend, które pobierają dane albo zmieniają katalog roboczy. */
  timeoutMs?: number;
  /**
   * Komenda może łączyć się z serwerem (`fetch`, `remote set-head`, `merge` z filtrem LFS): środowisko bez pytań
   * (`networkEnv`); `sshCommand` to `core.sshCommand` z konfiguracji repo i użytkownika.
   */
  network?: GitNetwork;
  /** Indeks zamiast indeksu repo (`GIT_INDEX_FILE`): zmiany zadania liczone bez dotykania indeksu, którego używa agent. */
  indexFile?: string;
};

/** `core.sshCommand` z konfiguracji repo i użytkownika dla komendy, która łączy się z serwerem. */
export type GitNetwork = { sshCommand: string | undefined };

export async function git(repoDir: string, args: readonly string[], opts: GitOptions = {}): Promise<RunOutput> {
  const ceiling = await ceilingFor(repoDir);
  const { maxBytes, stdin } = opts;
  return runProgram("git", [...NO_REPO_COMMANDS, ...PLATFORM_CONFIG, "-C", repoDir, ...args], {
    maxBytes,
    stdin,
    label: `git ${args[0]}`,
    // Odczyt stanu nie może zakładać `index.lock`: daemon pyta cyklicznie, a użytkownik w tym czasie commituje.
    env: {
      ...gitEnv(),
      ...(opts.network && networkEnv(opts.network.sshCommand)),
      ...(opts.indexFile && { GIT_INDEX_FILE: opts.indexFile }),
      GIT_CEILING_DIRECTORIES: ceiling,
      GIT_OPTIONAL_LOCKS: "0",
    },
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  });
}

/** Pełny hash commita, na który wskazuje `ref`; `undefined`, gdy takiego commita nie ma. */
export async function revParse(dir: string, ref: string): Promise<string | undefined> {
  return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
    ({ stdout }) => stdout.toString("utf8").trim(),
    () => undefined,
  );
}

/** Pełna nazwa refu, na który wskazuje dowiązanie `ref` (np. `HEAD`); `undefined`, gdy to nie dowiązanie. */
export async function symbolicRef(dir: string, ref: string): Promise<string | undefined> {
  return git(dir, ["symbolic-ref", "--quiet", ref]).then(
    ({ stdout }) => stdout.toString("utf8").trim() || undefined,
    () => undefined,
  );
}

/**
 * Gałąź domyślna `remote` z `refs/remotes/<remote>/HEAD` (ustawia go `git clone`), bez pytania serwera; `undefined`,
 * gdy go nie ma albo wskazuje gałąź zdalną, której już nie ma.
 */
export async function knownDefaultBranch(dir: string, remote: string): Promise<string | undefined> {
  const prefix = `refs/remotes/${remote}/`;
  const ref = await symbolicRef(dir, `${prefix}HEAD`);
  if (!ref?.startsWith(prefix) || (await revParse(dir, ref)) === undefined) return undefined;
  return ref.slice(prefix.length);
}

/**
 * Katalog nadrzędny korzenia repo dla `GIT_CEILING_DIRECTORIES`: przy pustym albo uszkodzonym `.git` git nie szuka
 * repo wyżej, więc nie pokaże repo, w którym leży folder z projektami (np. katalog domowy pod gitem). Git porównuje
 * go ze ścieżką po rozwinięciu dowiązań, stąd `realpath`. Jawne `--git-dir` też zatrzymałoby szukanie, ale wyłącza
 * sprawdzenie właściciela repo (`safe.directory`), więc repo innego użytkownika z dysku sieciowego by przeszło.
 */
async function ceilingFor(repoDir: string): Promise<string> {
  // Brak katalogu zgłosi sam git (`-C`), z czytelnym komunikatem.
  const root = await realpath(repoDir).catch(() => resolvePath(repoDir));
  const ceiling = dirname(root);
  // Zmienna jest listą ścieżek; ścieżka z separatorem rozpadłaby się na kawałki i ochrona zniknęłaby po cichu.
  if (ceiling.includes(delimiter)) throw new Error(`ścieżka ${ceiling} zawiera znak "${delimiter}", którego git nie obsłuży`);
  return ceiling;
}

/**
 * Środowisko każdego programu, który uruchamia gita (`git`, a pod spodem także `gh repo clone` i `glab repo clone`):
 * bez zmiennych wybierających repo i bez czekania na hasło, bo daemon nie ma terminala.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPO_SELECTING_ENV) delete env[name];
  return env;
}

/**
 * Dodatki do `gitEnv()` dla komend, które łączą się z serwerem: daemon nie ma terminala ani okna, więc każde pytanie
 * o hasło, token albo klucz hosta wisiałoby do limitu czasu w ukrytej konsoli. Pusty `GIT_ASKPASS` (git nie pyta
 * wtedy przez program, także odziedziczony z terminala VS Code), Git Credential Manager bez okien i ssh w trybie
 * wsadowym, chyba że użytkownik sam ustawił program ssh (`GIT_SSH_COMMAND`, `GIT_SSH`, `core.sshCommand`): wtedy
 * zostaje jego, bo `GIT_SSH_COMMAND` daemona przykryłby go.
 */
export function networkEnv(sshCommand: string | undefined, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_ASKPASS: "", GCM_INTERACTIVE: "never" };
  if (!(inherited.GIT_SSH_COMMAND || inherited.GIT_SSH || sshCommand)) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}
