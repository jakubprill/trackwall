import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { envKey } from "../../infra/env-key.ts";

/**
 * The Copilot CLI program (§4.4): the full path of a file that can be run without a shell. `npm install -g` gives
 * `copilot.cmd` on Windows, and running it through `cmd.exe` breaks arguments with spaces and `&` (other quoting rules),
 * so instead of the script we take the native `copilot.exe` from the platform package, as the script itself does. On
 * macOS Homebrew gives a plain executable.
 */

/** The program's full path or `undefined` when it is missing; `program` can be a name from `PATH` or a full path. */
export function findCopilot(program: string, env: NodeJS.ProcessEnv): string | undefined {
  const found = which(program, env);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return found;
  return nativeCopilot(found);
}

function nativeCopilot(script: string): string | undefined {
  const npmPackage = join(dirname(script), "node_modules", "@github", "copilot", "package.json");
  try {
    // The platform package exports only the binary (`exports: { ".": "./copilot.exe" }`).
    const exe = createRequire(npmPackage).resolve(`@github/copilot-${process.platform}-${process.arch}`);
    return isFile(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Looks for a program like a shell: in the `PATH` directories, on Windows with the extensions from `PATHEXT` (in their
 * order, like `cmd.exe`). A name with a slash is a path, not a name to look for.
 */
function which(program: string, env: NodeJS.ProcessEnv): string | undefined {
  const windows = process.platform === "win32";
  const extensions = windows && extname(program) === "" ? (pathValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const candidates = (base: string) => extensions.map((ext) => base + ext.toLowerCase());
  if (isAbsolute(program) || /[\\/]/.test(program)) return candidates(program).find(isFile);
  const dirs = (pathValue(env, "PATH") ?? "").split(delimiter).filter((d) => d !== "");
  for (const dir of dirs) {
    const found = candidates(join(dir, program)).find(isFile);
    if (found) return found;
  }
  return undefined;
}

function pathValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[envKey(env, name)];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
