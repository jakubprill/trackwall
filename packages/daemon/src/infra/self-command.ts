import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary, runtimeInfo } from "../platform/runtime.ts";

/**
 * The command that runs this daemon with a subcommand (the MCP stdio bridge, a session plugin hook), for another
 * program to run. A release binary is just its own path; from source it is the runtime with `src/main.ts`, whatever
 * script started this process, so a script that builds a daemon of its own (`scripts/demo.ts`) hands out the same.
 */
export function selfCommand(args: readonly string[]): { exec: string; args: string[] } {
  const fromSource = isCompiledBinary() ? [] : [...runtimeArgs(), fileURLToPath(new URL("../main.ts", import.meta.url))];
  return { exec: process.execPath, args: [...fromSource, ...args] };
}

/**
 * Bun bez `.env` i `bunfig.toml` z katalogu, w którym uruchomi go tamten program (repo, w którym pracuje agent,
 * ustawiałoby zmienne i preload); `--config` wskazuje pusty `bunfig.toml` paczki daemona. Node z flagami daemona,
 * bo bez nich nie uruchomi TypeScriptu.
 */
function runtimeArgs(): string[] {
  if (runtimeInfo().name === "node") return process.execArgv;
  const emptyBunfig = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bunfig.toml");
  return ["--no-env-file", `--config=${emptyBunfig}`];
}
