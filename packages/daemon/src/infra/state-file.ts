import { readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-write.ts";
import { messageOf } from "./errors.ts";

/**
 * The format of a JSON file of the state directory (ADR-223): its schema and the migrations that bring a file written
 * by an older Trackwall up to it. The file is an object whose `version` says which format wrote it; a file without one
 * is version 1, the format before versions. `migrations[i]` turns a file of version i + 1 into version i + 2, so the
 * format's own version is one more than their count, and a schema change that an older file would fail comes with a
 * migration instead of moving the user's file aside. The test `state-files.test.ts` reads every kept file of an older
 * version, so a change without one fails there.
 */
export interface StateFormat<T extends object> {
  readonly schema: z.ZodType<T>;
  readonly migrations: readonly StateMigration[];
}

/**
 * One step of a format's migrations. It gets the file as JSON from disk, which a person may have edited, so it parses what
 * it touches; a migration that throws leaves the file moved aside as broken, never the daemon stopped.
 */
export type StateMigration = (file: Record<string, unknown>) => Record<string, unknown>;

export function stateFormat<T extends object>(schema: z.ZodType<T>, migrations: readonly StateMigration[] = []): StateFormat<T> {
  return { schema, migrations };
}

/** The version a format writes. */
export function stateVersion(format: StateFormat<object>): number {
  return format.migrations.length + 1;
}

/** Writes `value` to a state file under the format's version, atomically. */
export function writeStateFile<T extends object>(path: string, format: StateFormat<T>, value: T): void {
  writeFileAtomic(path, stateFileText(format, value));
}

function stateFileText<T extends object>(format: StateFormat<T>, value: T): string {
  return `${JSON.stringify({ version: stateVersion(format), ...value }, null, 2)}\n`;
}

/**
 * A JSON file of the state directory read through its format: `undefined` when it is missing. A file that is not JSON
 * or fails the schema after its migrations is moved aside (`<file>.broken-<time>`), and so is one a newer Trackwall
 * wrote (`<file>.newer-<time>`), which this one cannot read without losing what the newer one added; so the next write
 * does not lose what a person may still want from it, and `broken` learns what was wrong and where the file went.
 */
export function readStateFile<T extends object>(
  path: string,
  format: StateFormat<T>,
  broken: (problem: string, aside: string) => void,
): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = parse(text, format);
  if (parsed.success) return parsed.data;
  const aside = `${path}.${parsed.newer ? "newer" : "broken"}-${Date.now()}`;
  renameSync(path, aside);
  broken(parsed.problem, aside);
  return undefined;
}

/**
 * A state file that follows a value while the daemon works (ADR-95, ADR-115): written when its JSON changes, and never
 * again once the daemon stops (`stopFollowing`), so the value of that moment stays for the next daemon, whatever the
 * stop itself changes. A failed write goes to `log` and is tried again at the next `follow`, so the change that asked
 * for it never fails.
 */
export class FollowedStateFile<T extends object> {
  readonly #path: string;
  readonly #format: StateFormat<T>;
  readonly #broken: (problem: string, aside: string) => void;
  readonly #log: (msg: string) => void;
  /** The last content written, so an unchanged value is not written again. */
  #written: string | undefined;
  #following = true;

  constructor(
    path: string,
    format: StateFormat<T>,
    { broken, log }: { broken: (problem: string, aside: string) => void; log: (msg: string) => void },
  ) {
    this.#path = path;
    this.#format = format;
    this.#broken = broken;
    this.#log = log;
  }

  /** What the previous daemon left, as `readStateFile` reads it. */
  read(): T | undefined {
    return readStateFile(this.#path, this.#format, this.#broken);
  }

  /** The value now; nothing once the daemon stops. */
  follow(value: T): void {
    if (!this.#following) return;
    const text = stateFileText(this.#format, value);
    if (text === this.#written) return;
    try {
      writeFileAtomic(this.#path, text);
      this.#written = text;
    } catch (err) {
      this.#log(`writing ${this.#path}: ${String(err)}`);
    }
  }

  stopFollowing(): void {
    this.#following = false;
  }
}

/**
 * Whether the file at `path` was written by a newer version of the format than this Trackwall reads, which
 * `readStateFile` would set aside; `false` for a file that is missing or does not read at all.
 */
export function writtenByNewer(path: string, format: StateFormat<object>): boolean {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  const object = StateObject.safeParse(json);
  return object.success && (object.data.version ?? 1) > stateVersion(format);
}

/** A state file: an object whose `version`, when it has one, is a whole number from 1. */
const StateObject = z.looseObject({ version: z.int().min(1).optional() });

type Parsed<T> = { success: true; data: T } | { success: false; problem: string; newer: boolean };

function parse<T extends object>(text: string, format: StateFormat<T>): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { success: false, problem: "not JSON", newer: false };
  }
  const object = StateObject.safeParse(json);
  if (!object.success) return { success: false, problem: "not an object with a valid version", newer: false };
  const from = object.data.version ?? 1;
  const current = stateVersion(format);
  if (from > current)
    return { success: false, problem: `written by a newer Trackwall (state format ${from}, this one reads up to ${current})`, newer: true };
  let file: Record<string, unknown> = object.data;
  for (let v = from; v < current; v++) {
    const migrate = format.migrations[v - 1];
    if (migrate === undefined) throw new Error(`state format ${current} has no migration from ${v}`);
    try {
      file = migrate(file);
    } catch (err) {
      return { success: false, problem: `migration to state format ${v + 1} failed: ${messageOf(err)}`, newer: false };
    }
  }
  const { version: _, ...value } = file;
  const parsed = format.schema.safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : { success: false, problem: z.prettifyError(parsed.error), newer: false };
}
