import { accessSync, constants } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { envKey } from "./env-key.ts";
import { DomainError } from "./errors.ts";

/**
 * The shell of a folder terminal (ADR-185): the user's own, from the daemon's environment, never from a request. On
 * Windows the command processor `ComSpec` names, on macOS and Linux `$SHELL`, as a terminal app opens them; a relative or
 * missing one falls back to the system's. macOS's terminals start a login shell, which reads `.zprofile`; Linux's do not.
 */

const POSIX_FALLBACKS = ["/bin/bash", "/bin/sh"];

export function userShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = executable,
): string[] {
  if (platform === "win32") {
    const comspec = env[envKey(env, "ComSpec")];
    if (comspec && win32.isAbsolute(comspec)) return [comspec];
    return [win32.join(env[envKey(env, "SystemRoot")] ?? "C:\\Windows", "System32", "cmd.exe")];
  }
  const shell = [env.SHELL, ...POSIX_FALLBACKS].find((path) => path !== undefined && isAbsolute(path) && isExecutable(path));
  if (shell === undefined)
    throw new DomainError("terminal_unavailable", `no shell to start: neither $SHELL nor ${POSIX_FALLBACKS.join(" nor ")} can run`);
  return platform === "darwin" ? [shell, "-l"] : [shell];
}

/** A shell's command, and the line the caller writes onto its screen above the first prompt (`null`: none to write). */
export interface ShellStart {
  command: readonly string[];
  screenLine: string | null;
}

/**
 * The shell's start with `firstLine` above its first prompt. ConPTY on Windows clears the screen when the console
 * starts, so a line written onto the screen before it is gone by the first prompt; there `cmd.exe /K echo` prints it
 * inside the console instead. On macOS and Linux the PTY passes the screen through, and the caller writes the line.
 * The line is the daemon's own text, never a request's: `echo` would run whatever `&` or `|` follows in it.
 */
export function shellStart(shell: readonly string[], firstLine: string | null, platform: NodeJS.Platform = process.platform): ShellStart {
  if (firstLine === null) return { command: shell, screenLine: null };
  if (platform === "win32") return { command: [...shell, "/K", `echo ${firstLine}`], screenLine: null };
  return { command: shell, screenLine: firstLine };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
