import { spawn } from "node:child_process";

/**
 * Krótkie wywołania `mise` dla zapytań (`tasks ls`, `trust`): bez grupy procesów, z limitem czasu. Taski
 * uruchamia się przez moduł `procs`, nigdy tędy.
 */

const TIMEOUT_MS = 15_000;
/** `mise tasks ls --json` z setkami tasków to kilkaset KB; więcej znaczy, że coś jest nie tak. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export type MiseCliResult =
  | { kind: "exited"; code: number | null; stdout: string; stderr: string }
  /** Programu nie ma w `PATH` (albo nie da się go uruchomić); komunikat po polsku. */
  | { kind: "not_found"; message: string };

export function runMiseCli(
  command: readonly string[],
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<MiseCliResult> {
  const [program, ...pre] = command;
  if (program === undefined) throw new Error("pusta komenda mise");
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...pre, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mise ${args[0]} nie skończył w ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_STDOUT_BYTES) out.push(chunk);
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const message =
        e.code === "ENOENT" ? `nie znaleziono programu ${program} w PATH` : `nie udało się uruchomić ${program}: ${e.message}`;
      resolve({ kind: "not_found", message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (size > MAX_STDOUT_BYTES) return reject(new Error(`mise ${args[0]}: wyjście większe niż ${MAX_STDOUT_BYTES} B`));
      resolve({ kind: "exited", code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}
