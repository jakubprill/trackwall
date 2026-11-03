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

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
