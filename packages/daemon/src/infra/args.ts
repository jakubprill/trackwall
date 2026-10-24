import { parseArgs } from "node:util";

export interface DaemonArgs {
  port: number;
  ui: boolean;
  uiDir?: string;
  parent?: number;
  home?: string;
  allowOrigins: string[];
  help: boolean;
  version: boolean;
}

export const USAGE = `trackwall-daemon [options]
trackwall-daemon mcp-stdio [--home <dir>]
                   stdio bridge to the MCP server of the running daemon (for Copilot CLI)
trackwall-daemon copilot-hook <event> <hooks.jsonl>
                   hook of the Copilot CLI session plugin (run by Copilot CLI, not by a person)

  --ui             open the UI in the default browser (mode without Tauri)
  --ui-dir <dir>   directory of the built UI (default: ./ui next to the binary)
  --port <n>       port on 127.0.0.1 (default: random)
  --parent <pid>   PID of the Tauri process that started the daemon
  --home <dir>     state directory (default: ~/.trackwall or TRACKWALL_HOME)
  --allow-origin <origin>
                   extra browser origin allowed to call the API (e.g. the Vite server during tauri dev)
  --version        print the version
  -h, --help       this help
`;

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      ui: { type: "boolean", default: false },
      "ui-dir": { type: "string" },
      port: { type: "string", default: "0" },
      parent: { type: "string" },
      home: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const port = toInt(values.port, "--port");
  if (port < 0 || port > 65535) throw new Error("--port out of range 0-65535");
  const allowOrigins = values["allow-origin"] ?? [];
  for (const origin of allowOrigins) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(origin)) {
      throw new Error(`--allow-origin accepts only http://127.0.0.1:<port> or http://localhost:<port>, got "${origin}"`);
    }
  }
  const parent = values.parent === undefined ? undefined : toInt(values.parent, "--parent");
  return {
    port,
    ui: values.ui ?? false,
    uiDir: values["ui-dir"],
    parent,
    home: values.home,
    allowOrigins,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function toInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} expects an integer, got "${value}"`);
  return n;
}

/** Podkomenda `trackwall-daemon`, która uruchamia most stdio do `/mcp` (§5.3). */
export const MCP_STDIO_COMMAND = "mcp-stdio";
/** Podkomenda `trackwall-daemon`, którą Copilot CLI uruchamia jako hook wtyczki sesji (ADR-17, ADR-26). */
export const COPILOT_HOOK_COMMAND = "copilot-hook";

/**
 * Wiersz poleceń: daemon, most stdio (`mcp-stdio [--home <dir>]`), który ma do ustawienia tylko katalog stanu, albo
 * hook wtyczki sesji (`copilot-hook <zdarzenie> <hooks.jsonl>`).
 */
export type CommandLine =
  | { command: "daemon"; args: DaemonArgs }
  | { command: typeof MCP_STDIO_COMMAND; home?: string }
  | { command: typeof COPILOT_HOOK_COMMAND; event?: string; hooksFile?: string };

/** Hook nie sprawdza argumentów: zły argument to tylko brak rekordu, a hook nie może zatrzymać agenta błędem. */
export function parseCommandLine(argv: string[]): CommandLine {
  if (argv[0] === COPILOT_HOOK_COMMAND) return { command: COPILOT_HOOK_COMMAND, event: argv[1], hooksFile: argv[2] };
  if (argv[0] !== MCP_STDIO_COMMAND) return { command: "daemon", args: parseDaemonArgs(argv) };
  const { values } = parseArgs({ args: argv.slice(1), options: { home: { type: "string" } }, strict: true, allowPositionals: false });
  return { command: MCP_STDIO_COMMAND, home: values.home };
}
