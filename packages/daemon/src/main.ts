#!/usr/bin/env bun
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "./api/event-hub.ts";
import { sessionHookRequest } from "./api/hooks.ts";
import { type ApiServer, startApi } from "./api/server.ts";
import { isUiDir } from "./api/static.ts";
import { createErrorJournal, createFacade, type Facade, HOSTING_CLIS } from "./facade.ts";
import { type CommandLine, type DaemonArgs, MCP_STDIO_COMMAND, parseCommandLine, USAGE } from "./infra/args.ts";
import { newToken, probeRunningDaemon, watchDaemonFile, withStartLock, writeDaemonFile } from "./infra/discovery.ts";
import { trackwallHome } from "./infra/home.ts";
import { SHUTDOWN_SIGNALS, shutdownOnce, stopDaemon } from "./infra/shutdown.ts";
import { openBrowser, openFolder } from "./infra/system-open.ts";
import { userEnv } from "./infra/user-env.ts";
import { VERSION } from "./infra/version.ts";
import { createMcpEndpoint, sessionMcpRequest } from "./mcp/endpoint.ts";
import { runStdioBridge } from "./mcp/stdio-bridge.ts";
import { mcpStdioCommand } from "./mcp/stdio-command.ts";
import { runtimeInfo } from "./platform/runtime.ts";

/** Exit codes read by Tauri. */
const EXIT_USAGE = 2;
const EXIT_OTHER_VERSION_RUNNING = 3;

async function main(args: DaemonArgs): Promise<void> {
  const home = trackwallHome(args.home);
  const uiDir = resolveUiDir(args.uiDir);
  const startedAt = new Date().toISOString();
  let facade: Facade | undefined;
  // An error that ends the daemon goes into the error journal first (ADR-94); before the facade exists, into a journal of its own.
  const fatal = (area: string, err: unknown) => {
    process.stderr.write(`[daemon] ${area}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    const journal = facade?.errorJournal ?? createErrorJournal({ home, version: VERSION, log });
    journal.recordDaemonError(area, err);
    journal.flush();
  };
  // The daemon still exits, as it did without the handlers: its state after an error nobody caught is not to be trusted.
  // The exit is in `finally`, so a journal that cannot be written does not change how the daemon ends.
  const fatalExit = (area: string, err: unknown) => {
    try {
      fatal(area, err);
    } finally {
      process.exit(1);
    }
  };
  process.on("uncaughtException", (err) => fatalExit("uncaught", err));
  process.on("unhandledRejection", (reason) => fatalExit("unhandled-rejection", reason));
  try {
    await start(args, home, uiDir, startedAt, (created) => {
      facade = created;
    });
  } catch (err) {
    fatalExit("startup", err);
  }
}

async function start(
  args: DaemonArgs,
  home: string,
  uiDir: string | undefined,
  startedAt: string,
  onFacade: (facade: Facade) => void,
): Promise<void> {
  // The state needed to stop is declared before the API starts: shutdown can come as an HTTP request
  // or a signal at any moment after the port opens.
  let api: ApiServer | undefined;
  let facade: Facade | undefined;
  let stopWatching = () => {};
  // Sessions start only through the API, so their hooks and MCP server always have its port.
  const apiPort = () => {
    if (!api) throw new Error("a session started before the API listens");
    return api.port;
  };
  const shutdown = shutdownOnce(async (reason) => {
    log(`stopping (${reason})`);
    stopWatching();
    await stopDaemon(home, facade, api);
  });

  const started = await withStartLock(home, async () => {
    const running = await probeRunningDaemon(home);
    if (running) return { kind: "existing" as const, ...running };
    const token = newToken();
    facade = createFacade({
      home,
      openUrl: openBrowser,
      openFolder,
      miseCommand: ["mise"],
      copilotCommand: ["copilot"],
      version: VERSION,
      sessionHook: (event, sessionToken) => sessionHookRequest(apiPort(), token, event, sessionToken),
      sessionMcpServer: (sessionToken) => sessionMcpRequest(apiPort(), token, sessionToken),
      hostingClis: HOSTING_CLIS,
      userEnv,
      uiDir,
      log,
    });
    onFacade(facade);
    facade.agents.sweepLeftovers();
    // Under the start lock: a second daemon cannot meanwhile start a group that this one would take for an orphan.
    await facade.procs.sweepOrphans().catch((err: unknown) => log(`cleaning up orphans from runtime.json: ${String(err)}`));
    api = await startApi(
      {
        token,
        version: VERSION,
        uiDir,
        allowOrigins: args.allowOrigins,
        info: () => ({
          version: VERSION,
          pid: process.pid,
          startedAt,
          uptimeMs: Math.round(process.uptime() * 1000),
          platform: platform(),
          arch: arch(),
          runtime: runtimeInfo(),
          launchedBy: args.parent === undefined ? "manual" : "desktop",
          home,
          mcpStdioCommand: mcpStdioCommand(home),
        }),
        onShutdown: () => void shutdown("POST /api/daemon/shutdown"),
        facade,
        mcp: createMcpEndpoint({ facade, version: VERSION, log: (msg) => log(`[mcp] ${msg}`) }),
        events: new EventHub({ facade, log: (msg) => log(`[events] ${msg}`) }),
      },
      args.port,
    );
    // After the API: the first comparison hands every repo to the card warm-up, and its git processes must not delay the start.
    facade.repoWatch.start();
    facade.localConfig.start();
    // After the API too: a resumed session's hooks and MCP server need its port (ADR-95).
    void facade.agents.resumeLeftSessions();
    const self = { pid: process.pid, port: api.port, token, startedAt, version: VERSION };
    writeDaemonFile(home, self);
    return { kind: "started" as const, self };
  });

  if (started.kind === "existing") {
    if (started.version !== VERSION) {
      log(`a daemon of another version is running (${started.version}, pid ${started.file.pid}); stop it before starting ${VERSION}`);
      process.exit(EXIT_OTHER_VERSION_RUNNING);
    }
    log(`daemon ${VERSION} is already running (pid ${started.file.pid}, port ${started.file.port})`);
    if (args.ui) openBrowser(uiUrl(started.file.port, started.file.token));
    return;
  }

  const { self } = started;
  stopWatching = watchDaemonFile(home, self, (other) => void shutdown(`daemon.json points to pid ${other.pid}`));
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutdown(signal));
  }

  log(`trackwall-daemon ${VERSION} at http://127.0.0.1:${self.port} (pid ${process.pid}, ${runtimeInfo().name}, state in ${home})`);
  if (!uiDir) log("no built UI: the API works, but no page will be served (build packages/ui or pass --ui-dir)");
  if (args.ui) {
    if (uiDir) openBrowser(uiUrl(self.port, self.token));
    else log("--ui ignored because there is no UI to show");
  }
}

/** Order: `--ui-dir`, `TRACKWALL_UI_DIR`, `ui/` next to the binary (portable), `packages/ui/dist` (dev). */
function resolveUiDir(explicit: string | undefined): string | undefined {
  if (explicit) return isUiDir(explicit) ? explicit : undefined;
  const candidates = [process.env.TRACKWALL_UI_DIR, join(dirname(process.execPath), "ui")];
  try {
    candidates.push(fileURLToPath(new URL("../../ui/dist", import.meta.url)));
  } catch {
    // in a compiled binary import.meta.url points to the virtual file system
  }
  return candidates.find(isUiDir);
}

/** The token in the URL fragment: it does not reach the server, logs or the Referer header. The UI removes it from the address bar. */
function uiUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${token}`;
}

function log(msg: string): void {
  process.stderr.write(`[daemon] ${msg}\n`);
}

let commandLine: CommandLine;
try {
  commandLine = parseCommandLine(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(EXIT_USAGE);
}
if (commandLine.command === MCP_STDIO_COMMAND) {
  runMcpStdio(trackwallHome(commandLine.home));
} else if (commandLine.args.help) {
  process.stdout.write(USAGE);
} else if (commandLine.args.version) {
  process.stdout.write(`${VERSION}\n`);
} else {
  void main(commandLine.args);
}

/**
 * The Stdio bridge to the running daemon's MCP server. stdout belongs to the MCP protocol, so the bridge's messages go only to
 * stderr; the process ends by itself once stdout is drained (`process.exit` would cut off replies waiting in the pipe buffer).
 */
function runMcpStdio(home: string): void {
  const log = (msg: string) => process.stderr.write(`[mcp-stdio] ${msg}\n`);
  runStdioBridge({ home, input: process.stdin, output: process.stdout, log }).catch((err: unknown) => {
    log(String(err));
    process.exitCode = 1;
  });
}
