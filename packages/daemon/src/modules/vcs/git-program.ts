import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { runProgram } from "../../infra/run-program.ts";

/**
 * Which program `git()` starts (§4.5, ADR-79). `git` on `PATH` of Git for Windows is the launcher `cmd\git.exe` (or a
 * package manager's shim), which starts the real `mingw64\bin\git.exe` as a second process: where an antivirus or EDR scans every process start (about a
 * second on a managed machine), each call pays that twice. On Windows the daemon therefore asks the launcher once for git's
 * `--exec-path` and from then on starts the real binary itself, with the same directories at the front of `PATH` that the
 * launcher adds, so filters (`sh`, `git-lfs`) still resolve. Elsewhere, or when the layout is not the usual one, `git`.
 * The user can choose another git in Settings (`gitProgram`, ADR-112), resolved the same way; network commands keep `git`
 * from `PATH` whatever the choice (`GIT_FROM_PATH`).
 */

export interface GitProgram {
  command: string;
  /** Directories to put in front of `PATH` for this program; empty for `git` from `PATH`. */
  pathPrefix: string[];
}

export const GIT_FROM_PATH: GitProgram = { command: "git", pathPrefix: [] };

/** Where the program for local calls came from: git from `PATH`, the chosen one, or `PATH` because the chosen one did not answer. */
export type GitProgramSource = "path" | "chosen" | "fallback";

export interface GitResolution {
  program: GitProgram;
  source: GitProgramSource;
}

/**
 * The "Git program" setting (ADR-112), handed over by `Vcs.useGitProgram` when the daemon starts, when Settings saves it and
 * when Settings reads it; `null` for git from `PATH`. Process-wide, like the slots of `git.ts`, because `git()` is a free
 * function every part of `vcs` calls; kept here, not read from `workspace.yaml` per call, because every git call asks for it.
 */
let setting: string | null = null;
/** One resolution per program ever chosen, so that switching back and forth asks `--exec-path` once per program. */
const resolved = new Map<string | null, Promise<GitResolution>>();
/** Programs whose last resolution fell back to `PATH`: handing one over again tries it again. */
const fellBack = new Set<string>();

export function useGitProgram(path: string | null): void {
  setting = path;
  if (path !== null && fellBack.delete(path)) resolved.delete(path);
}

export function chosenGitProgram(): string | null {
  return setting;
}

/** The program for local git calls (see `gitResolution`). */
export async function gitProgram(): Promise<GitProgram> {
  return (await gitResolution()).program;
}

/**
 * The program for local git calls and where it came from, resolved once per setting. A chosen program that does not answer
 * gives git from `PATH`, which still works, and the doctor says so (ADR-112).
 */
export function gitResolution(): Promise<GitResolution> {
  const known = resolved.get(setting);
  if (known) return known;
  const resolution = resolveProgram(setting);
  resolved.set(setting, resolution);
  return resolution;
}

async function resolveProgram(chosen: string | null): Promise<GitResolution> {
  if (chosen === null && process.platform !== "win32") return { program: GIT_FROM_PATH, source: "path" };
  // The chosen program can be MinGit's launcher `cmd\git.exe` too: asking it for `--exec-path` finds the real binary.
  const command = chosen ?? "git";
  try {
    const { stdout } = await runProgram(command, ["--exec-path"], { label: "git --exec-path", env: process.env, timeoutMs: 30_000 });
    const direct = process.platform === "win32" ? directGit(stdout.toString("utf8").trim(), existsSync) : undefined;
    return { program: direct ?? { command, pathPrefix: [] }, source: chosen === null ? "path" : "chosen" };
  } catch {
    if (chosen === null) return { program: GIT_FROM_PATH, source: "path" };
    fellBack.add(chosen);
    return { program: GIT_FROM_PATH, source: "fallback" };
  }
}

/**
 * The real git next to Git for Windows' exec path (`<root>\mingw64\libexec\git-core` → `<root>\mingw64\bin\git.exe`, also
 * `ucrt64` or `clangarm64` in other builds), with `<root>\mingw64\bin` and `<root>\usr\bin` for `PATH`; `undefined` when it is not there.
 */
export function directGit(execPath: string, exists: (path: string) => boolean): GitProgram | undefined {
  if (execPath === "") return undefined;
  const binDir = win32.resolve(execPath, "..", "..", "bin");
  const command = win32.join(binDir, "git.exe");
  if (!exists(command)) return undefined;
  const usrBin = win32.resolve(binDir, "..", "..", "usr", "bin");
  return { command, pathPrefix: exists(usrBin) ? [binDir, usrBin] : [binDir] };
}

/** `env` with `prefix` in front of its `PATH`, whatever the case of the variable's name (`Path` on Windows). */
export function withPathPrefix(env: NodeJS.ProcessEnv, prefix: readonly string[]): NodeJS.ProcessEnv {
  if (prefix.length === 0) return env;
  const name = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const rest = env[name];
  return { ...env, [name]: [...prefix, ...(rest ? [rest] : [])].join(win32.delimiter) };
}
