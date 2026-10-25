import { z } from "zod";

/**
 * A schema of a string holding JSON: bad JSON and a bad shape give the same kind of zod error. One place for "`JSON.parse`
 * and a schema" on outside data (recording lines, `hooks.jsonl`, a hook's stdin).
 */
export function jsonOf<T extends z.ZodType>(schema: T) {
  return z
    .string()
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: "not valid JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);
}
