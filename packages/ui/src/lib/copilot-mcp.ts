import { copilotMcpServers, MCP_SERVER_NAME } from "@trackwall/protocol";

/**
 * Connecting the Trackwall MCP server to Copilot CLI (§5.3, ADR-24): the `copilot mcp add` command, which adds an entry
 * to `~/.copilot/mcp-config.json`, and the entry itself to paste by hand. The daemon gives the stdio bridge (`mcpStdioCommand`).
 */

/** The command for the user's shell: PowerShell on Windows, sh/zsh on macOS. */
export function copilotMcpAddCommand(mcpStdioCommand: readonly string[], platform: string): string {
  const quote = platform === "win32" ? quotePowerShell : quotePosix;
  return ["copilot", "mcp", "add", MCP_SERVER_NAME, "--", ...mcpStdioCommand].map(quote).join(" ");
}

/** The Copilot CLI MCP config file in the user's home directory, written the way their system knows it. */
export function copilotMcpConfigPath(platform: string): string {
  return platform === "win32" ? "%USERPROFILE%\\.copilot\\mcp-config.json" : "~/.copilot/mcp-config.json";
}

/** Ten sam wpis w formacie `mcp-config.json`. */
export function copilotMcpConfig(mcpStdioCommand: readonly string[]): string {
  return JSON.stringify(copilotMcpServers(mcpStdioCommand), null, 2);
}

/** An argument without special characters stays as it is; any other goes in single quotes, inside which the shell expands nothing. */
const PLAIN_POSIX = /^[\w@%+=:,./\\-]+$/;
/**
 * PowerShell has more special characters in argument mode: `,` builds an array, and a leading `@` is splatting.
 * An argument starting with `-` also goes in single quotes: PowerShell takes a bare `--` for the end of parameters and
 * does not pass it to the script (`copilot.ps1` from `npm install -g`), and Windows PowerShell 5.1 splits program
 * arguments such as `--config=C:\x.toml` at the dot.
 */
const PLAIN_POWERSHELL = /^[\w%+=:./\\][\w%+=:./\\-]*$/;

function quotePosix(arg: string): string {
  return PLAIN_POSIX.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function quotePowerShell(arg: string): string {
  // PowerShell also ends a string at typographic apostrophes (U+2018, U+2019), so they are doubled too.
  return PLAIN_POWERSHELL.test(arg) ? arg : `'${arg.replace(/['\u2018\u2019]/g, "$&$&")}'`;
}
