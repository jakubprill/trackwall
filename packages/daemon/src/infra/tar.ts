import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { runProgram } from "./run-program.ts";

/**
 * Unpacks a `.tar.gz` with the system's `tar`: bsdtar on macOS and on Windows 10 and later, GNU tar on Linux. On Windows it
 * is `tar.exe` from System32, since a GNU tar from Git's `usr/bin` earlier in `PATH` takes `C:` in a path for a remote host.
 */
export async function extractTarGz(archive: string, dir: string, o: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<void> {
  await runProgram(tarProgram(process.platform, o.env), ["-xzf", archive, "-C", dir], { label: "tar -xzf", ...o });
}

/** The system's tar by full path where it has a fixed place, so a `tar` earlier in the user's PATH (a shim, a tools folder) does not run. */
export function tarProgram(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string {
  if (platform === "darwin") return "/usr/bin/tar";
  // Linux distributions without merged /usr keep it in /bin, and NixOS has neither.
  if (platform !== "win32") return ["/usr/bin/tar", "/bin/tar"].find(exists) ?? "tar";
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe");
}
