import { spawn } from "node:child_process";

/**
 * Uruchamianie `git` dla modułu `vcs`. Argumenty zawsze tablicą, bez powłoki; katalog repo przez `-C`,
 * żeby brak katalogu był błędem gita z czytelnym komunikatem, a nie `ENOENT` mylony z brakiem gita.
 */

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

export function git(repoDir: string, args: readonly string[], opts: GitOptions = {}): Promise<GitOutput> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoDir, ...args], { env: gitEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    child.on("close", (code) => {
      if (code === 0) return finish(() => resolve({ stdout: Buffer.concat(out), truncated: false }));
      const stderr = Buffer.concat(err).toString("utf8").trim();
      finish(() => reject(new Error(stderr || `git ${args[0]} zakończył się kodem ${code}`)));
    });
    // Git, który nie czyta stdin, może go zamknąć przed zapisem; EPIPE nie jest wtedy błędem wywołania.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Odczyt stanu nie może zakładać `index.lock`: daemon pyta cyklicznie, a użytkownik w tym czasie commituje.
    GIT_OPTIONAL_LOCKS: "0",
    // Daemon nie ma terminala; git nie może czekać na hasło.
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of REPO_SELECTING_ENV) delete env[name];
  return env;
}
