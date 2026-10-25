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
 * Bun without `.env` and `bunfig.toml` from the directory the other program starts it in (the repo the agent works in
 * would set variables and a preload); `--config` points to the daemon package's empty `bunfig.toml`. Node with the daemon's
 * flags, because without them it will not run TypeScript.
 */
function runtimeArgs(): string[] {
  if (runtimeInfo().name === "node") return process.execArgv;
  const emptyBunfig = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bunfig.toml");
  return ["--no-env-file", `--config=${emptyBunfig}`];
}
