import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { envKey } from "../../infra/env-key.ts";

/**
 * Program Copilot CLI (§4.4): pełna ścieżka pliku, który da się uruchomić bez powłoki. `npm install -g` daje na
 * Windowsie `copilot.cmd`, a uruchomienie go przez `cmd.exe` psuje argumenty ze spacjami i `&` (inne reguły
 * cytowania), więc zamiast skryptu bierzemy natywny `copilot.exe` z paczki platformy, tak jak robi to sam skrypt.
 * Na macOS Homebrew daje zwykły plik wykonywalny.
 */

/** Pełna ścieżka programu albo `undefined`, gdy go nie ma; `program` może być nazwą z `PATH` albo pełną ścieżką. */
export function findCopilot(program: string, env: NodeJS.ProcessEnv): string | undefined {
  const found = which(program, env);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return found;
  return nativeCopilot(found);
}

function nativeCopilot(script: string): string | undefined {
  const npmPackage = join(dirname(script), "node_modules", "@github", "copilot", "package.json");
  try {
    // Paczka platformy eksportuje sam plik binarny (`exports: { ".": "./copilot.exe" }`).
    const exe = createRequire(npmPackage).resolve(`@github/copilot-${process.platform}-${process.arch}`);
    return isFile(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Szuka programu jak powłoka: w katalogach `PATH`, na Windowsie z rozszerzeniami z `PATHEXT` (w ich kolejności, jak
 * `cmd.exe`). Nazwa z ukośnikiem to ścieżka, a nie nazwa do szukania.
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
