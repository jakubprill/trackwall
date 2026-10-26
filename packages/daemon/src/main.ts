#!/usr/bin/env bun
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "./api/event-hub.ts";
import { sessionHookRequest } from "./api/hooks.ts";
import { type ApiServer, startApi } from "./api/server.ts";
import { isUiDir } from "./api/static.ts";
import { createFacade, type Facade, HOSTING_CLIS } from "./facade.ts";
import { type CommandLine, type DaemonArgs, MCP_STDIO_COMMAND, parseCommandLine, USAGE } from "./infra/args.ts";
import { newToken, probeRunningDaemon, watchDaemonFile, withStartLock, writeDaemonFile } from "./infra/discovery.ts";
import { trackwallHome } from "./infra/home.ts";
import { SHUTDOWN_SIGNALS, shutdownOnce, stopDaemon } from "./infra/shutdown.ts";
import { openBrowser, openFolder } from "./infra/system-open.ts";
import { userEnv } from "./infra/user-env.ts";
import { VERSION } from "./infra/version.ts";
import { createMcpEndpoint } from "./mcp/endpoint.ts";
import { runStdioBridge } from "./mcp/stdio-bridge.ts";
import { mcpStdioCommand, sessionMcpStdioCommand } from "./mcp/stdio-command.ts";
import { runtimeInfo } from "./platform/runtime.ts";

/** Exit codes read by Tauri. */
const EXIT_USAGE = 2;
const EXIT_OTHER_VERSION_RUNNING = 3;

async function main(args: DaemonArgs): Promise<void> {
  const home = trackwallHome(args.home);
  const uiDir = resolveUiDir(args.uiDir);
  const startedAt = new Date().toISOString();

  // The state needed to stop is declared before the API starts: shutdown can come as an HTTP request
  // or a signal at any moment after the port opens.
  let api: ApiServer | undefined;
  let facade: Facade | undefined;
  let stopWatching = () => {};
  // Sessions start only through the API, so their hooks always have its port.
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
      sessionMcpCommand: (tokenFile) => sessionMcpStdioCommand(home, tokenFile),
      hostingClis: HOSTING_CLIS,
      userEnv,
      log,
    });
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
  runMcpStdio(trackwallHome(commandLine.home), commandLine.sessionTokenFile);
} else if (commandLine.args.help) {
  process.stdout.write(USAGE);
} else if (commandLine.args.version) {
  process.stdout.write(`${VERSION}\n`);
} else {
  main(commandLine.args).catch((err: unknown) => {
    process.stderr.write(`[daemon] startup error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}

/**
 * The Stdio bridge to the running daemon's MCP server. stdout belongs to the MCP protocol, so the bridge's messages go only to
 * stderr; the process ends by itself once stdout is drained (`process.exit` would cut off replies waiting in the pipe buffer).
 */
function runMcpStdio(home: string, sessionTokenFile: string | undefined): void {
  const log = (msg: string) => process.stderr.write(`[mcp-stdio] ${msg}\n`);
  runStdioBridge({ home, sessionTokenFile, input: process.stdin, output: process.stdout, log }).catch((err: unknown) => {
    log(String(err));
    process.exitCode = 1;
  });
}
