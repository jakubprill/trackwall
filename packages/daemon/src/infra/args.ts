import { parseArgs } from "node:util";
import { CONTAINER_COMMAND, SUPERVISE_COMMAND } from "./container-supervisor.ts";

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
trackwall-daemon address [--home <dir>]
                   print the running daemon's page address with its token (to open it in a browser;
                   whoever sees the output can use the daemon until it restarts)
trackwall-daemon container start [--port <n>] [--home <dir>]
                   in a dev container: make sure a daemon runs on the port (default 7700), restarted
                   after a crash, and print how it stands as JSON (trackwall-container start)

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
/** The `trackwall-daemon` subcommand that prints the running daemon's page address with its token (ADR-161). */
export const ADDRESS_COMMAND = "address";
const SUBCOMMANDS = [MCP_STDIO_COMMAND, ADDRESS_COMMAND] as const;
/** `container start` is for people and the desktop app; `container supervise` only for `start` to run (ADR-164). */
export const CONTAINER_START = "start";
const CONTAINER_ACTIONS = [CONTAINER_START, SUPERVISE_COMMAND] as const;
/** The port VS Code forwards in the dev container guide. */
const CONTAINER_DEFAULT_PORT = 7700;
/** The command line: the daemon, or a subcommand of the running daemon, which has only the state directory to set. */
export type CommandLine =
  | { command: "daemon"; args: DaemonArgs }
  | { command: typeof MCP_STDIO_COMMAND; home?: string }
  | { command: typeof ADDRESS_COMMAND; home?: string }
  | { command: typeof CONTAINER_COMMAND; action: (typeof CONTAINER_ACTIONS)[number]; port: number; home?: string };

export function parseCommandLine(argv: string[]): CommandLine {
  if (argv[0] === CONTAINER_COMMAND) return parseContainerCommand(argv.slice(1));
  const command = SUBCOMMANDS.find((name) => name === argv[0]);
  if (command === undefined) return { command: "daemon", args: parseDaemonArgs(argv) };
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { home: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  return { command, home: values.home };
}

function parseContainerCommand(argv: string[]): CommandLine {
  const action = CONTAINER_ACTIONS.find((name) => name === argv[0]);
  if (action === undefined) throw new Error(`${CONTAINER_COMMAND} expects ${CONTAINER_ACTIONS[0]}, got "${argv[0] ?? ""}"`);
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { home: { type: "string" }, port: { type: "string", default: String(CONTAINER_DEFAULT_PORT) } },
    strict: true,
    allowPositionals: false,
  });
  const port = toInt(values.port, "--port");
  if (port < 1 || port > 65535) throw new Error("--port out of range 1-65535");
  return { command: CONTAINER_COMMAND, action, port, home: values.home };
}
