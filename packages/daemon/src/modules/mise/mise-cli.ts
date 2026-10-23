import { spawn } from "node:child_process";
import { spawnFailure } from "../../errors.ts";

/**
 * Krótkie wywołania `mise` dla zapytań (`tasks ls`, `trust`): bez grupy procesów, z limitem czasu. Taski
 * uruchamia się przez moduł `procs`, nigdy tędy. Nie rzuca: każdy wynik to stan, który moduł pokazuje użytkownikowi.
 * Zakończenie po przekroczeniu limitu dotyczy tylko `mise`; program, który mise uruchomił z `[env]` zaufanej
 * konfiguracji, może przeżyć (§8).
 */

const TIMEOUT_MS = 15_000;
/** `mise tasks ls --json` z setkami tasków to kilkaset KB; więcej znaczy, że coś jest nie tak. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export type MiseCliResult =
  | { kind: "exited"; code: number | null; stdout: string; stderr: string }
  /** Programu nie ma w `PATH` (albo nie da się go uruchomić); komunikat po polsku. */
  | { kind: "not_started"; message: string }
  /** mise przekroczył limit czasu albo wyjścia i został zakończony. */
  | { kind: "failed"; message: string };

export function runMiseCli(
  command: readonly string[],
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<MiseCliResult> {
  const [program, ...pre] = command;
  if (program === undefined) throw new Error("pusta komenda mise");
  return new Promise((resolve) => {
    const child = spawn(program, [...pre, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.stdout.destroy();
      child.kill();
      resolve({ kind: "failed", message: `mise ${args[0]} nie skończył w ${TIMEOUT_MS / 1000} s` });
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_STDOUT_BYTES) return void out.push(chunk);
      // Bez czekania na `close`: rury może trzymać wnuk (np. mise za shimem), który przeżyje zabicie.
      clearTimeout(timer);
      child.stdout.destroy();
      child.kill();
      resolve({ kind: "failed", message: `mise ${args[0]}: wyjście większe niż ${MAX_STDOUT_BYTES} B` });
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
