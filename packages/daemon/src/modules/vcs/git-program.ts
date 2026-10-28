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

/**
 * The "Git program" setting (ADR-112), handed over by `Vcs.useGitProgram` when the daemon starts and when Settings saves it;
 * `null` for git from `PATH`. Kept here, not read from `workspace.yaml` per call, because every git call asks for it.
 */
let setting: string | null = null;
/** One resolution per program ever chosen, so that switching back and forth asks `--exec-path` once per program. */
const resolved = new Map<string | null, Promise<GitProgram>>();

export function useGitProgram(path: string | null): void {
  setting = path;
}

export function chosenGitProgram(): string | null {
  return setting;
}

/**
 * The program for local git calls, resolved once per setting. A chosen program that no longer answers gives git from `PATH`,
 * which still works, and the doctor names the git it got (ADR-112).
 */
export function gitProgram(): Promise<GitProgram> {
  const known = resolved.get(setting);
  if (known) return known;
  const program = resolveProgram(setting);
  resolved.set(setting, program);
  return program;
}

function resolveProgram(chosen: string | null): Promise<GitProgram> {
  if (process.platform !== "win32") return Promise.resolve(chosen === null ? GIT_FROM_PATH : { command: chosen, pathPrefix: [] });
  // The chosen program can be MinGit's launcher `cmd\git.exe` too: asking it for `--exec-path` finds the real binary.
  const command = chosen ?? "git";
  return runProgram(command, ["--exec-path"], { label: "git --exec-path", env: process.env, timeoutMs: 30_000 }).then(
    ({ stdout }) => directGit(stdout.toString("utf8").trim(), existsSync) ?? { command, pathPrefix: [] },
    () => GIT_FROM_PATH,
  );
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
