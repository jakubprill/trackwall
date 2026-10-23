import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { delimiter, dirname, resolve as resolvePath } from "node:path";

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
/** Górny limit wyjścia, gdy wołający nie poda własnego: lista plików ogromnego katalogu, długi log. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

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

export interface GitOutput {
  stdout: Buffer;
  /** Wyjście dłuższe niż `maxBytes` zostało ucięte, a proces zakończony. */
  truncated: boolean;
}

export interface GitOptions {
  maxBytes?: number;
  /** Wejście dla komend czytających z stdin (`cat-file --batch-check`). */
  stdin?: string;
}

export async function git(repoDir: string, args: readonly string[], opts: GitOptions = {}): Promise<GitOutput> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ceiling = await ceilingFor(repoDir);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...NO_REPO_COMMANDS, "-C", repoDir, ...args], {
      env: gitEnv(ceiling),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;

    // Na Windowsie `git` z PATH bywa launcherem (`cmd\git.exe`), który uruchamia właściwego gita jako dziecko.
    // Zabicie launchera nie zamyka rur trzymanych przez wnuka, więc wynik ustalamy bez czekania na `close`.
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      if (child.exitCode === null) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
      }
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`git ${args[0]} nie skończył w ${TIMEOUT_MS} ms`))), TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const room = maxBytes - size;
      out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.length, room);
      if (chunk.length > room) finish(() => resolve({ stdout: Buffer.concat(out), truncated: true }));
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e: NodeJS.ErrnoException) => {
      const message = e.code === "ENOENT" ? "nie znaleziono programu git w PATH" : `nie udało się uruchomić gita: ${e.message}`;
      finish(() => reject(new Error(message)));
    });
    child.on("close", (code, signal) => {
      if (code === 0) return finish(() => resolve({ stdout: Buffer.concat(out), truncated: false }));
      const stderr = Buffer.concat(err).toString("utf8").trim();
      const reason = signal ? `przerwany sygnałem ${signal}` : `zakończył się kodem ${code}`;
      finish(() => reject(new Error(stderr || `git ${args[0]} ${reason}`)));
    });
    // Git, który nie czyta stdin, może go zamknąć przed zapisem; EPIPE nie jest wtedy błędem wywołania.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
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

function gitEnv(ceiling: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: ceiling,
    // Odczyt stanu nie może zakładać `index.lock`: daemon pyta cyklicznie, a użytkownik w tym czasie commituje.
    GIT_OPTIONAL_LOCKS: "0",
    // Daemon nie ma terminala; git nie może czekać na hasło.
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of REPO_SELECTING_ENV) delete env[name];
  return env;
}
