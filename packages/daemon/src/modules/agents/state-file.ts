import { readFileSync, renameSync } from "node:fs";
import { z } from "zod";

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
