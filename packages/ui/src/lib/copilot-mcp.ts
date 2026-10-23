import { MCP_SERVER_NAME } from "@trackwall/protocol";

/**
 * Podłączenie serwera MCP Trackwall do Copilot CLI (§5.3, ADR-24): komenda `copilot mcp add`, która dopisuje wpis do
 * `~/.copilot/mcp-config.json`, i sam wpis do wklejenia ręcznie. Most stdio (`mcpStdioCommand`) podaje daemon.
 */

/** Komenda dla powłoki użytkownika: PowerShell na Windowsie, sh/zsh na macOS. */
export function copilotMcpAddCommand(mcpStdioCommand: readonly string[], platform: string): string {
  const quote = platform === "win32" ? quotePowerShell : quotePosix;
  return ["copilot", "mcp", "add", MCP_SERVER_NAME, "--", ...mcpStdioCommand].map(quote).join(" ");
}

/** Plik konfiguracji MCP Copilot CLI w katalogu domowym użytkownika, zapisany tak, jak zna go jego system. */
export function copilotMcpConfigPath(platform: string): string {
  return platform === "win32" ? "%USERPROFILE%\\.copilot\\mcp-config.json" : "~/.copilot/mcp-config.json";
}

/** Ten sam wpis w formacie `mcp-config.json`. */
export function copilotMcpConfig(mcpStdioCommand: readonly string[]): string {
  const [command, ...args] = mcpStdioCommand;
  const config = { mcpServers: { [MCP_SERVER_NAME]: { type: "local", command, args, tools: ["*"] } } };
  return JSON.stringify(config, null, 2);
}

/** Argument bez znaków specjalnych zostaje jak jest; inny w apostrofach, w których powłoka nic nie rozwija. */
const PLAIN_POSIX = /^[\w@%+=:,./\\-]+$/;
/**
 * PowerShell ma więcej znaków specjalnych w trybie argumentów: `,` buduje tablicę, a `@` na początku to splatting.
 * Argument zaczynający się od `-` też idzie w apostrofach: gołe `--` PowerShell bierze za koniec parametrów i nie
 * przekazuje go skryptowi (`copilot.ps1` z `npm install -g`), a Windows PowerShell 5.1 dzieli argumenty programów
 * w rodzaju `--config=C:\x.toml` na kropce.
 */
const PLAIN_POWERSHELL = /^[\w%+=:./\\][\w%+=:./\\-]*$/;

function quotePosix(arg: string): string {
  return PLAIN_POSIX.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function quotePowerShell(arg: string): string {
  // PowerShell kończy napis także na apostrofach typograficznych (U+2018, U+2019), więc i je podwaja.
  return PLAIN_POWERSHELL.test(arg) ? arg : `'${arg.replace(/['\u2018\u2019]/g, "$&$&")}'`;
}
