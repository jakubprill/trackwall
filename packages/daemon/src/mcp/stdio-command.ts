import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_STDIO_COMMAND } from "../args.ts";
import { defaultTrackwallHome } from "../home.ts";
import { isCompiledBinary, runtimeInfo } from "../platform/runtime.ts";

/**
 * Komenda mostu stdio dla tego daemona, do konfiguracji MCP CLI agenta (`copilot mcp add trackwall -- …`). Binarka
 * z wydania to sama ścieżka binarki; uruchomienie ze źródeł dokłada runtime i skrypt. Agent uruchamia most w swoim
 * katalogu roboczym i bez zmiennych daemona, więc niedomyślny katalog stanu (tryb deweloperski) trafia do komendy
 * jako `--home`.
 */
export function mcpStdioCommand(home: string): string[] {
  const script = process.argv[1];
  const fromSource = !isCompiledBinary() && script !== undefined ? [...runtimeArgs(), resolve(script)] : [];
  const homeArgs = resolve(home) === defaultTrackwallHome() ? [] : ["--home", resolve(home)];
  return [process.execPath, ...fromSource, MCP_STDIO_COMMAND, ...homeArgs];
}

/**
 * Bun bez `.env` i `bunfig.toml` z katalogu agenta (repo, w którym pracuje agent, ustawiałoby zmienne i preload
 * mostu); `--config` wskazuje pusty `bunfig.toml` paczki daemona. Node z flagami daemona, bo bez nich nie uruchomi
 * TypeScriptu.
 */
function runtimeArgs(): string[] {
  if (runtimeInfo().name === "node") return process.execArgv;
  const emptyBunfig = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bunfig.toml");
  return ["--no-env-file", `--config=${emptyBunfig}`];
}
