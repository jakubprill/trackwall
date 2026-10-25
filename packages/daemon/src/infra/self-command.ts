import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary, runtimeInfo } from "../platform/runtime.ts";

/**
 * Komenda, która uruchamia ten sam daemon z podkomendą (most stdio MCP, hook wtyczki sesji), do podania innemu
 * programowi. Binarka z wydania to sama ścieżka binarki; uruchomienie ze źródeł dokłada runtime i skrypt.
 * From source the script is always `src/main.ts`, not `process.argv[1]`, so a script that builds a daemon of its own
 * (`scripts/demo.ts`) hands out the same commands.
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
