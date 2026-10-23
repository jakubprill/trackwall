import { resolve } from "node:path";
import { MCP_STDIO_COMMAND } from "../args.ts";
import { defaultTrackwallHome } from "../home.ts";
import { selfCommand } from "../self-command.ts";

/**
 * Komenda mostu stdio dla tego daemona, do konfiguracji MCP CLI agenta (`copilot mcp add trackwall -- …`) i dla sesji
 * w widoku „Sesje” (ADR-26). Agent uruchamia most w swoim katalogu roboczym i bez zmiennych daemona, więc
 * niedomyślny katalog stanu (tryb deweloperski) trafia do komendy jako `--home`.
 */
export function mcpStdioCommand(home: string): string[] {
  const homeArgs = resolve(home) === defaultTrackwallHome() ? [] : ["--home", resolve(home)];
  const { exec, args } = selfCommand([MCP_STDIO_COMMAND, ...homeArgs]);
  return [exec, ...args];
}
