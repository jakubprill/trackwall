import { MCP_SERVER_NAME } from "@trackwall/protocol";

/**
 * Podłączenie serwera MCP Trackwall do Copilot CLI (§5.3, ADR-22): komenda `copilot mcp add`, która dopisuje wpis do
 * `~/.copilot/mcp-config.json`, i sam wpis do wklejenia ręcznie. Most stdio (`mcpStdioCommand`) podaje daemon.
 */

/** Komenda dla powłoki użytkownika: PowerShell na Windowsie, sh/zsh na macOS. */
export function copilotMcpAddCommand(mcpStdioCommand: readonly string[], platform: string): string {
  const quote = platform === "win32" ? quotePowerShell : quotePosix;
  return ["copilot", "mcp", "add", MCP_SERVER_NAME, "--", ...mcpStdioCommand].map(quote).join(" ");
}

/** Ten sam wpis w formacie `~/.copilot/mcp-config.json`. */
export function copilotMcpConfig(mcpStdioCommand: readonly string[]): string {
  const [command, ...args] = mcpStdioCommand;
  const config = { mcpServers: { [MCP_SERVER_NAME]: { type: "local", command, args, tools: ["*"] } } };
  return JSON.stringify(config, null, 2);
}

/** Argument bez znaków specjalnych zostaje jak jest; inny w apostrofach, w których obie powłoki nic nie rozwijają. */
const PLAIN = /^[\w@%+=:,./\\-]+$/;

function quotePosix(arg: string): string {
  return PLAIN.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function quotePowerShell(arg: string): string {
  return PLAIN.test(arg) ? arg : `'${arg.replaceAll("'", "''")}'`;
}
