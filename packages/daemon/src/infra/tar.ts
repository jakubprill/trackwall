import { win32 } from "node:path";
import { runProgram } from "./run-program.ts";

/**
 * Unpacks a `.tar.gz` with the system's `tar`: bsdtar on macOS and on Windows 10 and later, GNU tar on Linux. On Windows it
 * is `tar.exe` from System32 by its full path, since a GNU tar from Git's `usr/bin` earlier in `PATH` takes `C:` in a
 * path for a remote host.
 */
export async function extractTarGz(archive: string, dir: string, o: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<void> {
  await runProgram(tarProgram(process.platform, o.env), ["-xzf", archive, "-C", dir], { label: "tar -xzf", ...o });
}

export function tarProgram(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform !== "win32") return "tar";
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe");
}
