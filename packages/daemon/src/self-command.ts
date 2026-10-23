import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary, runtimeInfo } from "./platform/runtime.ts";

/**
 * Komenda, która uruchamia ten sam daemon z podkomendą (most stdio MCP, hook wtyczki sesji), do podania innemu
 * programowi. Binarka z wydania to sama ścieżka binarki; uruchomienie ze źródeł dokłada runtime i skrypt.
 */
export function selfCommand(args: readonly string[]): { exec: string; args: string[] } {
  const script = process.argv[1];
  const fromSource = !isCompiledBinary() && script !== undefined ? [...runtimeArgs(), resolve(script)] : [];
  return { exec: process.execPath, args: [...fromSource, ...args] };
}

/**
 * Bun bez `.env` i `bunfig.toml` z katalogu, w którym uruchomi go tamten program (repo, w którym pracuje agent,
 * ustawiałoby zmienne i preload); `--config` wskazuje pusty `bunfig.toml` paczki daemona. Node z flagami daemona,
 * bo bez nich nie uruchomi TypeScriptu.
 */
function runtimeArgs(): string[] {
  if (runtimeInfo().name === "node") return process.execArgv;
  const emptyBunfig = join(dirname(fileURLToPath(import.meta.url)), "..", "bunfig.toml");
  return ["--no-env-file", `--config=${emptyBunfig}`];
}
