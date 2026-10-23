import { realpath } from "node:fs/promises";
import { delimiter, dirname, resolve as resolvePath } from "node:path";
import { type RunOutput, runProgram } from "./run.ts";

/**
 * Uruchamianie `git` dla modułu `vcs`. Argumenty zawsze tablicą, bez powłoki; katalog repo przez `-C`,
 * żeby brak katalogu był błędem gita z czytelnym komunikatem, a nie `ENOENT` mylony z brakiem gita.
 * `repoDir` to zawsze korzeń repo, a repo trafia na listę samo, gdy leży w folderze z projektami (ADR-18), więc
 * git nie może szukać repo powyżej niego, a klucze z `NO_REPO_COMMANDS` są wyłączone; reszta konfiguracji repo
 * obowiązuje (luka z filtrem `clean` w §8).
 */

/**
 * Klucze `.git/config`, którymi repo kazałoby gitowi uruchomić program przy komendach daemona:
 * `core.fsmonitor` przy `status`, `log.showSignature` (z `gpg.program`) przy `log`.
 */
const NO_REPO_COMMANDS = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];

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

export interface GitOptions {
  maxBytes?: number;
  /** Wejście dla komend czytających z stdin (`cat-file --batch-check`). */
  stdin?: string;
}

export async function git(repoDir: string, args: readonly string[], opts: GitOptions = {}): Promise<RunOutput> {
  const ceiling = await ceilingFor(repoDir);
  return runProgram("git", [...NO_REPO_COMMANDS, "-C", repoDir, ...args], {
    ...opts,
    label: `git ${args[0]}`,
    // Odczyt stanu nie może zakładać `index.lock`: daemon pyta cyklicznie, a użytkownik w tym czasie commituje.
    env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: ceiling, GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: TIMEOUT_MS,
  });
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
