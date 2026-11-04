import { parseArgs } from "node:util";
import { RELEASE_VERSION } from "@trackwall/protocol";

export interface DaemonArgs {
  port: number;
  /** The port of the service proxy (§5.6, ADR-189); `null` runs none. */
  proxyPort: number | null;
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
trackwall-daemon container update <version> [--port <n>] [--home <dir>]
                   in a dev container: download that release, check its signature, switch to it and go
                   back if it does not start; prints JSON at once, the rest goes to logs/daemon.log

  --ui             open the UI in the default browser (mode without Tauri)
  --ui-dir <dir>   directory of the built UI (default: ./ui next to the binary)
  --port <n>       port on 127.0.0.1 (default: random)
  --proxy-port <n> port on 127.0.0.1 of the proxy that opens running services in a browser at
                   http://<repo>.localhost:<n>/ (default: none; in a dev container the port after --port)
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
      "proxy-port": { type: "string" },
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
  const proxyPort = values["proxy-port"] === undefined ? null : toInt(values["proxy-port"], "--proxy-port");
  if (proxyPort !== null && (proxyPort < 1 || proxyPort > 65535)) throw new Error("--proxy-port out of range 1-65535");
  const allowOrigins = values["allow-origin"] ?? [];
  for (const origin of allowOrigins) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(origin)) {
      throw new Error(`--allow-origin accepts only http://127.0.0.1:<port> or http://localhost:<port>, got "${origin}"`);
    }
  }
  const parent = values.parent === undefined ? undefined : toInt(values.parent, "--parent");
  return {
    port,
    proxyPort,
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
/** The subcommand of `trackwall-daemon` behind `trackwall-container` in a dev container (ADR-164). */
export const CONTAINER_COMMAND = "container";
/** The container supervisor's own subcommand, also how its process is recognised in `/proc/<pid>/cmdline`. */
export const SUPERVISE_COMMAND = "supervise";
/** `container start` and `container update` are for people and the desktop app; the other two only for those to run. */
export const CONTAINER_START = "start";
export const CONTAINER_UPDATE = "update";
/** The background process of an update (ADR-165), also how its process is recognised in `/proc/<pid>/cmdline`. */
export const APPLY_UPDATE_COMMAND = "apply-update";
const CONTAINER_ACTIONS = [CONTAINER_START, CONTAINER_UPDATE, SUPERVISE_COMMAND, APPLY_UPDATE_COMMAND] as const;
const UPDATE_ACTIONS: readonly string[] = [CONTAINER_UPDATE, APPLY_UPDATE_COMMAND];
/** The port VS Code forwards in the dev container guide. */
const CONTAINER_DEFAULT_PORT = 7700;

/**
 * The service proxy's port in a dev container (ADR-189): the one after the daemon's, 7701 with the guide's 7700, so two
 * containers given ports apart each have their own and the guide forwards both. None after the last port.
 */
export function containerProxyPort(port: number): number | null {
  return port < 65535 ? port + 1 : null;
}
/** The command line: the daemon, or a subcommand of the running daemon, which has only the state directory to set. */
export type CommandLine =
  | { command: "daemon"; args: DaemonArgs }
  | { command: typeof MCP_STDIO_COMMAND; home?: string }
  | { command: typeof ADDRESS_COMMAND; home?: string }
  | ContainerCommandLine;
export type ContainerCommandLine =
  | { command: typeof CONTAINER_COMMAND; action: typeof CONTAINER_START | typeof SUPERVISE_COMMAND; port: number; home?: string }
  | {
      command: typeof CONTAINER_COMMAND;
      action: typeof CONTAINER_UPDATE | typeof APPLY_UPDATE_COMMAND;
      target: string;
      port: number;
      home?: string;
    };

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

function parseContainerCommand(argv: string[]): ContainerCommandLine {
  const action = CONTAINER_ACTIONS.find((name) => name === argv[0]);
  if (action === undefined) {
    throw new Error(`${CONTAINER_COMMAND} expects ${CONTAINER_START} or ${CONTAINER_UPDATE} <version>, got "${argv[0] ?? ""}"`);
  }
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: { home: { type: "string" }, port: { type: "string", default: String(CONTAINER_DEFAULT_PORT) } },
    strict: true,
    allowPositionals: UPDATE_ACTIONS.includes(action),
  });
  const port = toInt(values.port, "--port");
  if (port < 1 || port > 65535) throw new Error("--port out of range 1-65535");
  if (action === CONTAINER_START || action === SUPERVISE_COMMAND) return { command: CONTAINER_COMMAND, action, port, home: values.home };
  const [target, ...rest] = positionals;
  if (target === undefined || rest.length > 0 || !RELEASE_VERSION.test(target)) {
    throw new Error(`${CONTAINER_UPDATE} expects one version such as 1.2.3, got "${positionals.join(" ")}"`);
  }
  return { command: CONTAINER_COMMAND, action, target, port, home: values.home };
}
