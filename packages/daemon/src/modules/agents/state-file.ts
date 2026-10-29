import { readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";

/**
 * A JSON file of the state directory read through its schema: `undefined` when it is missing. A file that is not JSON
 * or fails the schema is moved aside (`<file>.broken-<time>`), so the next write does not lose what a person may still
 * want from it, and `broken` learns what was wrong and where the file went.
 */
export function readStateFile<T>(path: string, schema: z.ZodType<T>, broken: (problem: string, aside: string) => void): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = parse(text, schema);
  if (parsed.success) return parsed.data;
  const aside = `${path}.broken-${Date.now()}`;
  renameSync(path, aside);
  broken(parsed.problem, aside);
  return undefined;
}

/**
 * A state file that follows a value while the daemon works (ADR-95, ADR-115): written when its JSON changes, and never
 * again once the daemon stops (`stopFollowing`), so the value of that moment stays for the next daemon, whatever the
 * stop itself changes.
 */
export class FollowedStateFile<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  readonly #broken: (problem: string, aside: string) => void;
  /** The last content written, so an unchanged value is not written again. */
  #written: string | undefined;
  #following = true;

  constructor(path: string, schema: z.ZodType<T>, broken: (problem: string, aside: string) => void) {
    this.#path = path;
    this.#schema = schema;
    this.#broken = broken;
  }

  /** What the previous daemon left, as `readStateFile` reads it. */
  read(): T | undefined {
    return readStateFile(this.#path, this.#schema, this.#broken);
  }

  /** The value now; nothing once the daemon stops. */
  follow(value: T): void {
    if (!this.#following) return;
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (text === this.#written) return;
    writeFileAtomic(this.#path, text);
    this.#written = text;
  }

  stopFollowing(): void {
    this.#following = false;
  }
}

function parse<T>(text: string, schema: z.ZodType<T>): { success: true; data: T } | { success: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { success: false, problem: "not JSON" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { success: true, data: parsed.data } : { success: false, problem: z.prettifyError(parsed.error) };
}
