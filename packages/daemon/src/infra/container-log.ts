import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A line of the container supervisor or the update in `logs/daemon.log` (ADR-164, ADR-165), next to the daemon's own
 * output: what was started, stopped or checked, so a person in the container can follow it with `tail -f`.
 */
export function appendNote(logPath: string, who: "supervisor" | "update", msg: string): void {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const fd = openSync(logPath, "a", 0o600);
  try {
    writeSync(fd, `[${who}] ${new Date().toISOString()} ${msg}\n`);
  } finally {
    closeSync(fd);
  }
}
