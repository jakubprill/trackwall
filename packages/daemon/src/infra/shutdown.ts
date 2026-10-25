import type { ApiServer } from "../api/server.ts";
import type { Facade } from "../facade.ts";
import { removeDaemonFile } from "./discovery.ts";

/** The signals that stop the daemon: Ctrl+C, closing the console window on Windows (`SIGBREAK`, `SIGHUP`), `kill`. */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Stops everything a daemon started, in the order that keeps its state honest. Either part may be missing when the
 * stop comes before the daemon finished starting.
 */
export async function stopDaemon(home: string, facade: Facade | undefined, api: ApiServer | undefined): Promise<void> {
  // Process groups before the API closes, so the UI sees "stopping" and not a dropped connection. The batch command
  // first, so no further repo tries to start while the rest stops.
  facade?.batch.close();
  await facade?.procs.stopAll();
  facade?.agents.close();
  removeDaemonFile(home, process.pid);
  await api?.close();
  // Last: the final lines of the stopped groups, also those after the leader's `exit`, reach the log files.
  facade?.logs.flush();
}

/**
 * A stop that runs once, however many signals, `POST /api/daemon/shutdown` requests and failures ask for it, and then
 * ends the process with the exit code of the first one (1 when the stop itself fails).
 */
export function shutdownOnce(
  stop: (reason: string) => Promise<void>,
  exit: (code: number) => void = process.exit,
): (reason: string, exitCode?: number) => Promise<void> {
  let stopping: Promise<void> | undefined;
  return (reason, exitCode = 0) => {
    // A stop that fails still ends the process, with a failure code, so a half-stopped daemon does not linger.
    stopping ??= stop(reason)
      .then(
        () => exitCode,
        (err: unknown) => {
          process.stderr.write(`stopping failed: ${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        },
      )
      .then(exit);
    return stopping;
  };
}
