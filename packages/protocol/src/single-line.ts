import type { z } from "zod";

/**
 * One line of text without control characters (a task title, a board item title, a check step), so that it shows as
 * one row and carries no line breaks into the prompt it ends up in.
 */
export function singleLine(text: z.ZodString, what: string): z.ZodString {
  // `refine` instead of `regex`: the pattern would go into the MCP tool's JSON Schema, and a client that compiles it
  // without the `u` flag would read `\p{Cc}` as plain letters and reject ordinary text.
  return text.refine((value) => !/\p{Cc}/u.test(value), { message: `${what} must be a single line without control characters` });
}
