import { resolve } from "node:path";
import { MCP_STDIO_COMMAND, SESSION_TOKEN_FILE_OPTION } from "../infra/args.ts";
import { defaultTrackwallHome } from "../infra/home.ts";
import { selfCommand } from "../infra/self-command.ts";

/**
 * The stdio bridge command for this daemon, for an agent CLI's MCP configuration (`copilot mcp add trackwall -- …`) and for sessions
 * in the "Sessions" view (ADR-26). The agent starts the bridge in its working directory and without the daemon's variables, so
 * a non-default state directory (development mode) goes into the command as `--home`.
 */
export function mcpStdioCommand(home: string): string[] {
  const homeArgs = resolve(home) === defaultTrackwallHome() ? [] : ["--home", resolve(home)];
  const { exec, args } = selfCommand([MCP_STDIO_COMMAND, ...homeArgs]);
  return [exec, ...args];
}

/**
 * The Stdio bridge of a Copilot CLI session from the "Sessions" view: with the file of its session token, by which the MCP
 * server knows who is calling (ADR-39).
 */
export function sessionMcpStdioCommand(home: string, tokenFile: string): string[] {
  return [...mcpStdioCommand(home), SESSION_TOKEN_FILE_OPTION, tokenFile];
}
