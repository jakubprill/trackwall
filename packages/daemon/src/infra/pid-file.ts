import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAlive } from "./discovery.ts";

/**
 * A PID file that holds a role for one process at a time in a dev container (ADR-164, ADR-165): the container supervisor,
 * an update in progress. It appears with its content at once (written aside, then linked into place, which fails when the
 * file exists), so a reader never sees it empty, and a file left by a process that is gone is taken over. The holder is
 * recognised by its command line where `/proc` has it, since a PID from a previous container start can belong to any
 * process now.
 */

function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` runs a command line holding every one of `args` (only that it is alive, where there is no `/proc`). */
function runsCommand(pid: number, args: readonly string[]): boolean {
  if (!existsSync("/proc")) return isAlive(pid);
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.every((arg) => cmdline.includes(arg));
  } catch {
    return false;
  }
}

/** The PID in `file` when that process is still the holder. */
export function pidFileHolder(file: string, args: readonly string[]): number | undefined {
  const pid = readPid(file);
  return pid !== undefined && runsCommand(pid, args) ? pid : undefined;
}

/** Claims `file` for this process, or returns false when a live holder (by `args`) has it. */
export function claimPidFile(file: string, args: readonly string[]): boolean {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const aside = `${file}.${process.pid}`;
  writeFileSync(aside, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(aside, file);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = readPid(file);
      if (holder !== undefined && runsCommand(holder, args)) return false;
      takeAwayStale(file, holder);
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Moves a stale PID file out of the way; when what was moved names another PID than the stale one, another process
 * claimed the file meanwhile, and it goes back (linked, so a file claimed again in the meantime is not overwritten).
 */
function takeAwayStale(file: string, stale: number | undefined): void {
  const moved = `${file}.stale.${process.pid}`;
  try {
    renameSync(file, moved);
  } catch {
    return; // gone already
  }
  try {
    if (readPid(moved) !== stale) linkSync(moved, file);
  } catch {
    // claimed again meanwhile: that claim stands
  } finally {
    rmSync(moved, { force: true });
  }
}

/** Removes `file` while it still names this process. */
export function releasePidFile(file: string): void {
  if (readPid(file) === process.pid) rmSync(file, { force: true });
}
