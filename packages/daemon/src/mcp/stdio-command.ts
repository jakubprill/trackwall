import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeInfo } from "../platform/runtime.ts";

/** Podkomenda `trackwall-daemon`, która uruchamia most stdio do `/mcp` (§5.3). */
export const MCP_STDIO_COMMAND = "mcp-stdio";

/**
 * Komenda mostu stdio dla tego daemona, do konfiguracji MCP CLI agenta (`copilot mcp add trackwall -- …`). Binarka
 * z wydania to sama ścieżka binarki; uruchomienie ze źródeł dokłada skrypt (pod Node z flagami, z którymi wystartował
 * daemon). Agent uruchamia most w swoim katalogu roboczym i bez zmiennych daemona, więc niedomyślny katalog stanu
 * (tryb deweloperski) trafia do komendy jako `--home`.
 */
export function mcpStdioCommand(home: string): string[] {
  const script = process.argv[1];
  // W binarce z `bun build --compile` skrypt leży w wirtualnym systemie plików (`/$bunfs/…`), którego nie ma na dysku.
  const fromSource = script !== undefined && existsSync(script);
  const runtime = fromSource ? [...runtimeArgs(), resolve(script)] : [];
  const homeArgs = resolve(home) === join(homedir(), ".trackwall") ? [] : ["--home", resolve(home)];
  return [process.execPath, ...runtime, MCP_STDIO_COMMAND, ...homeArgs];
}

/**
 * Bun bez `.env` z katalogu agenta (inaczej repo, w którym pracuje agent, ustawiałoby zmienne mostu); Node z flagami
 * daemona, bo bez nich nie uruchomi TypeScriptu.
 */
function runtimeArgs(): string[] {
  return runtimeInfo().name === "bun" ? ["--no-env-file"] : process.execArgv;
}
