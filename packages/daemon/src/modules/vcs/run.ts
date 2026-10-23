import { spawn } from "node:child_process";

/**
 * Uruchamianie programów modułu `vcs` (`git`, `gh`, `glab`): argumenty zawsze tablicą, bez powłoki, wyjście
 * ograniczone, a błąd to komunikat z stderr. Procesy krótkie i bez grupy; długie procesy z zatrzymywaniem całego
 * drzewa należą do modułu `procs`.
 */

/** Górny limit wyjścia, gdy wołający nie poda własnego: lista plików ogromnego katalogu, długi log. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Z stderr zostaje koniec: przy błędzie tam jest przyczyna, a początek to zwykle postęp. */
const STDERR_TAIL_BYTES = 16 * 1024;

export interface RunOutput {
  stdout: Buffer;
  /** Wyjście dłuższe niż `maxBytes` zostało ucięte, a proces zakończony. */
  truncated: boolean;
}

export interface RunOptions {
  /** Jak nazwać wywołanie w komunikacie błędu, np. `git status`. */
  label: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes?: number;
  /** Wejście dla komend czytających z stdin (`cat-file --batch-check`). */
  stdin?: string;
}

export function runProgram(command: string, args: readonly string[], opts: RunOptions): Promise<RunOutput> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = Buffer.alloc(0);
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
    const timer = setTimeout(() => finish(() => reject(new Error(`${opts.label} nie skończył w ${opts.timeoutMs} ms`))), opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const room = maxBytes - size;
      out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.length, room);
      if (chunk.length > room) finish(() => resolve({ stdout: Buffer.concat(out), truncated: true }));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      const message =
        e.code === "ENOENT" ? `nie znaleziono programu ${command} w PATH` : `nie udało się uruchomić ${command}: ${e.message}`;
      finish(() => reject(new Error(message)));
    });
    child.on("close", (code, signal) => {
      if (code === 0) return finish(() => resolve({ stdout: Buffer.concat(out), truncated: false }));
      const reason = signal ? `przerwany sygnałem ${signal}` : `zakończył się kodem ${code}`;
      finish(() => reject(new Error(stderr.toString("utf8").trim() || `${opts.label} ${reason}`)));
    });
    // Program, który nie czyta stdin, może go zamknąć przed zapisem; EPIPE nie jest wtedy błędem wywołania.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
  });
}
