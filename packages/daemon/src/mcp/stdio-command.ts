import { resolve } from "node:path";
import { MCP_STDIO_COMMAND } from "../infra/args.ts";
import { defaultTrackwallHome } from "../infra/home.ts";
import { selfCommand } from "../infra/self-command.ts";

/**
 * The stdio bridge command for this daemon, for an agent CLI's MCP configuration (`copilot mcp add trackwall -- …`); the
 * daemon's own sessions reach `/mcp` over HTTP instead (ADR-89). The agent starts the bridge in its working directory
 * and without the daemon's variables, so a non-default state directory (development mode) goes into the command as
 * `--home`.
 */
export function mcpStdioCommand(home: string): string[] {
  const homeArgs = resolve(home) === defaultTrackwallHome() ? [] : ["--home", resolve(home)];
  const { exec, args } = selfCommand([MCP_STDIO_COMMAND, ...homeArgs]);
  return [exec, ...args];
}
