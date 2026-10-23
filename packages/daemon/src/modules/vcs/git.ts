import { spawn } from "node:child_process";

/**
 * Uruchamianie `git` dla modułu `vcs`. Argumenty zawsze tablicą, bez powłoki; katalog repo przez `-C`,
 * żeby brak katalogu był błędem gita z czytelnym komunikatem, a nie `ENOENT` mylony z brakiem gita.
 */

/** Zwykłe wywołania kończą się w ułamku sekundy; limit chroni przed wiszącym gitem (blokada, sieciowy dysk). */
const TIMEOUT_MS = 15_000;
/** Górny limit wyjścia, gdy wołający nie poda własnego: lista plików ogromnego katalogu, długi log. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const GIT_ENV = {
  // Odczyt stanu nie może zakładać `index.lock`: daemon pyta cyklicznie, a użytkownik w tym czasie commituje.
  GIT_OPTIONAL_LOCKS: "0",
  // Daemon nie ma terminala; git nie może czekać na hasło.
  GIT_TERMINAL_PROMPT: "0",
};

export class GitError extends Error {
  constructor(
    message: string,
    /** `undefined`, gdy gita nie udało się uruchomić. */
    readonly exitCode: number | undefined,
  ) {
    super(message);
  }
}

export interface GitOutput {
  stdout: Buffer;
  /** Wyjście dłuższe niż `maxBytes` zostało ucięte, a proces zakończony. */
  truncated: boolean;
}

export interface GitOptions {
  maxBytes?: number;
}

export function git(repoDir: string, args: readonly string[], opts: GitOptions = {}): Promise<GitOutput> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoDir, ...args], {
      env: { ...process.env, ...GIT_ENV },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - size;
      out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.length, room);
      if (chunk.length > room) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(
        new GitError(e.code === "ENOENT" ? "nie znaleziono programu git w PATH" : `nie udało się uruchomić gita: ${e.message}`, undefined),
      );
    });
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(out);
      if (truncated) return resolve({ stdout, truncated });
      if (code === 0) return resolve({ stdout, truncated: false });
      const stderr = Buffer.concat(err).toString("utf8").trim();
      const why = signal ? `przerwany (${signal}) po ${TIMEOUT_MS} ms albo z zewnątrz` : `kod ${code}`;
      reject(new GitError(stderr || `git ${args[0]} zakończył się: ${why}`, code ?? undefined));
    });
  });
}
