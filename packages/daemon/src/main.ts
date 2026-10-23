#!/usr/bin/env bun
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApi } from "./api/server.ts";
import { isUiDir } from "./api/static.ts";
import { type DaemonArgs, parseDaemonArgs, USAGE } from "./args.ts";
import { newToken, probeRunningDaemon, removeDaemonFile, withStartLock, writeDaemonFile } from "./discovery.ts";
import { pitwallHome } from "./home.ts";
import { openBrowser } from "./open-browser.ts";
import { runtimeInfo } from "./platform/runtime.ts";
import { VERSION } from "./version.ts";

/** Kody wyjścia czytane przez Tauri. */
const EXIT_USAGE = 2;
const EXIT_OTHER_VERSION_RUNNING = 3;

async function main(args: DaemonArgs): Promise<void> {
  const home = pitwallHome(args.home);
  const uiDir = resolveUiDir(args.uiDir);

  const startedAt = new Date().toISOString();
  let shuttingDown = false;

  const started = await withStartLock(home, async () => {
    const running = await probeRunningDaemon(home);
    if (running) return { kind: "existing" as const, ...running };
    const token = newToken();
    const api = await startApi(
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
        }),
        onShutdown: () => void shutdown("POST /api/daemon/shutdown"),
      },
      args.port,
    );
    writeDaemonFile(home, { pid: process.pid, port: api.port, token, startedAt, version: VERSION });
    return { kind: "started" as const, api, token };
  });

  if (started.kind === "existing") {
    if (started.version !== VERSION) {
      log(`działa daemon w innej wersji (${started.version}, pid ${started.file.pid}); zatrzymaj go przed startem ${VERSION}`);
      process.exit(EXIT_OTHER_VERSION_RUNNING);
    }
    log(`daemon ${VERSION} już działa (pid ${started.file.pid}, port ${started.file.port})`);
    if (args.ui) openBrowser(uiUrl(started.file.port, started.file.token));
    return;
  }

  const { api, token } = started;
  log(`pitwall-daemon ${VERSION} na http://127.0.0.1:${api.port} (pid ${process.pid}, ${runtimeInfo().name}, stan w ${home})`);
  if (!uiDir) log("brak zbudowanego UI: API działa, strona nie będzie serwowana (zbuduj packages/ui albo podaj --ui-dir)");
  if (args.ui) {
    if (uiDir) openBrowser(uiUrl(api.port, token));
    else log("--ui pominięte, bo nie ma UI do pokazania");
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`zatrzymywanie (${reason})`);
    // Etap 3: tutaj zatrzymanie serwisów i sesji agentów tym samym łagodnym stopem.
    removeDaemonFile(home, process.pid);
    await api.close();
    process.exit(0);
  }

  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.on(signal, () => void shutdown(signal));
  }
}

/** Kolejność: `--ui-dir`, `PITWALL_UI_DIR`, `ui/` obok binarki (portable), `packages/ui/dist` (dev). */
function resolveUiDir(explicit: string | undefined): string | undefined {
  if (explicit) return isUiDir(explicit) ? explicit : undefined;
  const candidates = [process.env.PITWALL_UI_DIR, join(dirname(process.execPath), "ui")];
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

let parsed: DaemonArgs;
try {
  parsed = parseDaemonArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(EXIT_USAGE);
}
if (parsed.help) {
  process.stdout.write(USAGE);
} else if (parsed.version) {
  process.stdout.write(`${VERSION}\n`);
} else {
  main(parsed).catch((err: unknown) => {
    process.stderr.write(`[daemon] błąd startu: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
