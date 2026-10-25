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
trackwall-daemon mcp-stdio [--home <dir>] [--session-token-file <file>]
                   stdio bridge to the MCP server of the running daemon (for Copilot CLI);
                   a Trackwall session passes the file with its session token
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

/** The `trackwall-daemon` subcommand that starts the Stdio bridge to `/mcp` (§5.3). */
export const MCP_STDIO_COMMAND = "mcp-stdio";
/**
 * The Stdio bridge option with the session token file (ADR-39): the daemon gives it in the MCP configuration of each of its sessions
 * so that the MCP server knows which session calls. A path instead of the token itself, because other users of the system see
 * process arguments.
 */
const SESSION_TOKEN_FILE_KEY = "session-token-file";
export const SESSION_TOKEN_FILE_OPTION = `--${SESSION_TOKEN_FILE_KEY}`;
/** The `trackwall-daemon` subcommand that Copilot CLI runs as the session plugin's hook (ADR-17, ADR-26). */
export const COPILOT_HOOK_COMMAND = "copilot-hook";

/**
 * The command line: the daemon, the Stdio bridge (`mcp-stdio [--home <dir>] [--session-token-file <file>]`), which has
 * only the state directory and the session token to set, or
 * the session plugin's hook (`copilot-hook <event> <hooks.jsonl>`).
 */
export type CommandLine =
  | { command: "daemon"; args: DaemonArgs }
  | { command: typeof MCP_STDIO_COMMAND; home?: string; sessionTokenFile?: string }
  | { command: typeof COPILOT_HOOK_COMMAND; event?: string; hooksFile?: string };

/** The hook does not check arguments: a bad argument only means a missing record, and a hook must not stop the agent with an error. */
export function parseCommandLine(argv: string[]): CommandLine {
  if (argv[0] === COPILOT_HOOK_COMMAND) return { command: COPILOT_HOOK_COMMAND, event: argv[1], hooksFile: argv[2] };
  if (argv[0] !== MCP_STDIO_COMMAND) return { command: "daemon", args: parseDaemonArgs(argv) };
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { home: { type: "string" }, [SESSION_TOKEN_FILE_KEY]: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  return { command: MCP_STDIO_COMMAND, home: values.home, sessionTokenFile: values[SESSION_TOKEN_FILE_KEY] };
}
