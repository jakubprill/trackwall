import { join } from "node:path";
import { DaemonRestart } from "@trackwall/protocol";
import { RotatingJsonlFile, readRotatingJsonl } from "./rotating-jsonl-file.ts";

/**
 * The daemon's restarts after a crash in a container (ADR-164, ADR-279): the supervisor appends one line per restart,
 * and the container's health panel reads the last day of them. Beside `logs/daemon.log`, whose free text only a person
 * reads; the supervisor and the daemon are two processes, so the file is their contract.
 */

const RESTARTS_FILE = join("logs", "daemon-restarts.jsonl");
const MAX_BYTES = 256 * 1024;

export function recordRestart(home: string, restart: DaemonRestart, log: (msg: string) => void): void {
  const file = new RotatingJsonlFile(join(home, RESTARTS_FILE), MAX_BYTES, (err) =>
    log(`could not rotate the restarts file: ${String(err)}`),
  );
  file.append(JSON.stringify(restart));
  try {
    file.flush();
  } catch (err) {
    log(`could not record the restart: ${String(err)}`);
  }
}

/** The restarts at or after `since`, oldest first. */
export function readRestarts(home: string, since: Date): DaemonRestart[] {
  return readRotatingJsonl(join(home, RESTARTS_FILE), DaemonRestart).filter((r) => Date.parse(r.at) >= since.getTime());
}
