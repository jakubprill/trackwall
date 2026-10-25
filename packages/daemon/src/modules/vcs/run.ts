import { spawn } from "node:child_process";

/**
 * Runs the `vcs` module's programs (`git`, `gh`, `glab`): arguments always as an array, without a shell, output
 * limited, and an error is the message from stderr. Short processes without a group; long processes that stop the whole
 * tree belong to the `procs` module.
 */

/** The upper output limit when the caller gives none: the file list of a huge directory, a long log. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** The end of stderr is kept: on an error the cause is there, and the beginning is usually progress. */
const STDERR_TAIL_BYTES = 16 * 1024;

export interface RunOutput {
  stdout: Buffer;
  /** Output longer than `maxBytes` was cut and the process ended. */
  truncated: boolean;
}

export interface RunOptions {
  /** How to name the call in an error message, e.g. `git status`. */
  label: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes?: number;
  /** Input for commands that read stdin (`cat-file --batch-check`). */
  stdin?: string | Buffer;
  /** Exit codes other than 0 that are a result, not an error (`git grep`: 1 when nothing matches). */
  okExitCodes?: readonly number[];
}

export function runProgram(command: string, args: readonly string[], opts: RunOptions): Promise<RunOutput> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = Buffer.alloc(0);
    let settled = false;

    // On Windows `git` from PATH is sometimes a launcher (`cmd\git.exe`) that starts the real git as a child.
    // Killing the launcher does not close pipes held by the grandchild, so we settle the result without waiting for `close`.
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
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${opts.label} did not finish within ${opts.timeoutMs} ms`))),
      opts.timeoutMs,
    );

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
      const message = e.code === "ENOENT" ? `program ${command} not found in PATH` : `failed to start ${command}: ${e.message}`;
      finish(() => reject(new Error(message)));
    });
    child.on("close", (code, signal) => {
      if (code === 0 || (code !== null && opts.okExitCodes?.includes(code)))
        return finish(() => resolve({ stdout: Buffer.concat(out), truncated: false }));
      const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
      const message = stderr.toString("utf8").trim() || `${opts.label} ${reason}`;
      finish(() => reject(new Error(message)));
    });
    // A program that does not read stdin may close it before the write; EPIPE is then not an error of the call.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
  });
}
