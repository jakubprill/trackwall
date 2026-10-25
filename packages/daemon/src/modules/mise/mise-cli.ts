import { spawn } from "node:child_process";
import { spawnFailure } from "../../infra/errors.ts";

/**
 * Short `mise` calls for queries (`tasks ls`, `trust`): without a process group, with a time limit. mise tasks
 * run through the `procs` module, never this way. It does not throw: every result is a state the module shows the user.
 * Ending after the limit applies only to `mise`; a program that mise started from the `[env]` of a trusted
 * config may survive (§8).
 */

const TIMEOUT_MS = 15_000;
/** `mise tasks ls --json` with hundreds of mise tasks is a few hundred KB; more means something is wrong. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export type MiseCliResult =
  | { kind: "exited"; code: number | null; stdout: string; stderr: string }
  /** The program is not in `PATH` (or cannot be started); a message for the user. */
  | { kind: "not_started"; message: string }
  /** mise exceeded the time or output limit and was ended. */
  | { kind: "failed"; message: string };

export function runMiseCli(
  command: readonly string[],
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<MiseCliResult> {
  const [program, ...pre] = command;
  if (program === undefined) throw new Error("empty mise command");
  return new Promise((resolve) => {
    const child = spawn(program, [...pre, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.stdout.destroy();
      child.kill();
      resolve({ kind: "failed", message: `mise ${args[0]} did not finish within ${TIMEOUT_MS / 1000} s` });
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_STDOUT_BYTES) return void out.push(chunk);
      // Without waiting for `close`: a grandchild (e.g. mise behind a shim) may hold the pipes and survive the kill.
      clearTimeout(timer);
      child.stdout.destroy();
      child.kill();
      resolve({ kind: "failed", message: `mise ${args[0]}: output larger than ${MAX_STDOUT_BYTES} B` });
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ kind: "not_started", message: spawnFailure(program, e).message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ kind: "exited", code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}
