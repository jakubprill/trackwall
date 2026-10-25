#!/usr/bin/env bun
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "./api/event-hub.ts";
import { type ApiServer, startApi } from "./api/server.ts";
import { isUiDir } from "./api/static.ts";
import { createFacade, type Facade, runCopilotHook } from "./facade.ts";
import { COPILOT_HOOK_COMMAND, type CommandLine, type DaemonArgs, MCP_STDIO_COMMAND, parseCommandLine, USAGE } from "./infra/args.ts";
import { newToken, probeRunningDaemon, watchDaemonFile, withStartLock, writeDaemonFile } from "./infra/discovery.ts";
import { trackwallHome } from "./infra/home.ts";
import { selfCommand } from "./infra/self-command.ts";
import { SHUTDOWN_SIGNALS, shutdownOnce, stopDaemon } from "./infra/shutdown.ts";
import { openBrowser, openFolder } from "./infra/system-open.ts";
import { userEnv } from "./infra/user-env.ts";
import { VERSION } from "./infra/version.ts";
import { createMcpEndpoint } from "./mcp/endpoint.ts";
import { runStdioBridge } from "./mcp/stdio-bridge.ts";
import { mcpStdioCommand, sessionMcpStdioCommand } from "./mcp/stdio-command.ts";
import { runtimeInfo } from "./platform/runtime.ts";

/** Kody wyjścia czytane przez Tauri. */
const EXIT_USAGE = 2;
const EXIT_OTHER_VERSION_RUNNING = 3;

async function main(args: DaemonArgs): Promise<void> {
  const home = trackwallHome(args.home);
  const uiDir = resolveUiDir(args.uiDir);
  const startedAt = new Date().toISOString();

  // Stan potrzebny do zatrzymania jest zadeklarowany przed startem API: shutdown może przyjść żądaniem HTTP
  // albo sygnałem w dowolnym momencie po otwarciu portu.
  let api: ApiServer | undefined;
  let facade: Facade | undefined;
  let stopWatching = () => {};
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
      hookCommand: (event, hooksFile) => selfCommand([COPILOT_HOOK_COMMAND, event, hooksFile]),
      sessionMcpCommand: (tokenFile) => sessionMcpStdioCommand(home, tokenFile),
      userEnv,
      log,
    });
    facade.agents.sweepLeftovers();
    // Pod blokadą startu: drugi daemon nie może w tym czasie uruchomić grupy, którą ten wziąłby za sierotę.
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

/** Kolejność: `--ui-dir`, `TRACKWALL_UI_DIR`, `ui/` obok binarki (portable), `packages/ui/dist` (dev). */
function resolveUiDir(explicit: string | undefined): string | undefined {
  if (explicit) return isUiDir(explicit) ? explicit : undefined;
  const candidates = [process.env.TRACKWALL_UI_DIR, join(dirname(process.execPath), "ui")];
  try {
    candidates.push(fileURLToPath(new URL("../../ui/dist", import.meta.url)));
  } catch {
    // w skompilowanej binarce import.meta.url wskazuje na wirtualny system plików
  }
  return candidates.find(isUiDir);
}

/** Token w fragmencie URL: nie trafia do serwera, logów ani nagłówka Referer. UI usuwa go z paska adresu. */
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
} else if (commandLine.command === COPILOT_HOOK_COMMAND) {
  runHook(commandLine.event, commandLine.hooksFile);
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
 * Most stdio do serwera MCP działającego daemona. stdout należy do protokołu MCP, więc komunikaty mostu idą tylko na
 * stderr; proces kończy się sam po opróżnieniu stdout (`process.exit` ucięłoby odpowiedzi czekające w buforze rury).
 */
function runMcpStdio(home: string, sessionTokenFile: string | undefined): void {
  const log = (msg: string) => process.stderr.write(`[mcp-stdio] ${msg}\n`);
  runStdioBridge({ home, sessionTokenFile, input: process.stdin, output: process.stdout, log }).catch((err: unknown) => {
    log(String(err));
    process.exitCode = 1;
  });
}

/** Hook wtyczki sesji: payload na stdin, rekord do `hooks.jsonl`; nic na stdout i zawsze kod 0 (ADR-17). */
function runHook(event: string | undefined, hooksFile: string | undefined): void {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on("error", () => {});
  process.stdin.on("end", () => runCopilotHook(event, hooksFile, Buffer.concat(chunks).toString("utf8")));
}
