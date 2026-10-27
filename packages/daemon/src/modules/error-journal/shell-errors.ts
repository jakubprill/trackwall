import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync } from "node:fs";
import { z } from "zod";

/**
 * The desktop shell's errors (ADR-94): the shell appends one JSON line per error to `logs/shell-errors.jsonl` in the state
 * directory (`error_journal.rs`), because it has to keep them also when no daemon runs, and the daemon takes them into the
 * journal when the journal is read. The daemon renames the file to `shell-errors.taken.jsonl` before reading it, so a line
 * the shell appends afterwards goes into a new file, read the next time, and no line is counted twice. A line the shell was
 * writing at the very moment of the rename (both systems allow it, Windows too, since Rust opens files with
 * `FILE_SHARE_DELETE`) may be cut and is then skipped. A taken file a daemon could not finish (it stopped) is read first.
 */

/** The file's name in the state directory's `logs/`; the shell writes the same name (`SHELL_ERRORS_FILE` in `error_journal.rs`). */
export const SHELL_ERRORS_FILE = "shell-errors.jsonl";

/** A file bigger than this is an error in a loop: only its end is read. */
const MAX_READ_BYTES = 1024 * 1024;

/** One line of the shell's file; every field comes from the shell's own code, the message after its own formatting. */
const ShellErrorLine = z.object({
  atMs: z.number().int().nonnegative(),
  /** The shell file the error came from, without `.rs` (`badge`). */
  area: z.string().max(80),
  kind: z.enum(["error", "panic"]),
  message: z.string().max(8000),
  /** `src/badge.rs:201`, from the shell's sources; a panic in a library has none. */
  location: z.string().max(300).nullable(),
});
export type ShellErrorLine = z.infer<typeof ShellErrorLine>;

/** Takes the lines the shell has written since the last call; a line that is not the expected JSON is skipped. */
export function takeShellErrors(file: string): ShellErrorLine[] {
  const taken = file.replace(/\.jsonl$/, ".taken.jsonl");
  const left = existsSync(taken) ? readLines(taken) : [];
  try {
    renameSync(file, taken);
  } catch {
    // No file: nothing new from the shell.
    return left;
  }
  return [...left, ...readLines(taken)];
}

function readLines(taken: string): ShellErrorLine[] {
  try {
    const text = readTail(taken);
    return text.split(/\r?\n/).flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        const parsed = ShellErrorLine.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  } catch {
    // The file went away meanwhile (another daemon took it): its lines are that daemon's.
    return [];
  } finally {
    rmSync(taken, { force: true });
  }
}

function readTail(file: string): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** A shell source location as a path in Trackwall's repo; anything outside the shell's `src/` is left out. */
export function shellFrame(location: string | null): string | null {
  if (location === null) return null;
  const match = /^src[\\/]([\w/\\]+\.rs):(\d+)(?::\d+)?$/.exec(location);
  return match ? `apps/desktop/src-tauri/src/${match[1]?.replaceAll("\\", "/")}:${match[2]}` : null;
}
