import { parse, stringify } from "yaml";
import { messageOf } from "./errors.ts";

/**
 * A Markdown file with YAML frontmatter, the way Trackwall keeps text a person reads and edits in any editor (board items,
 * ADR-133; routines, ADR-173): `---`, the fields as YAML, `---`, then the body. Reading only splits the file; the caller
 * checks the fields with its schema, since the files lie where an agent with file tools can write too.
 */

const FENCE = "---";

export function writeFrontmatter(fields: Record<string, unknown>, body: string): string {
  return `${FENCE}\n${stringify(fields)}${FENCE}\n${body}`;
}

/** The fields (unchecked YAML) and the body of a file, or why it holds none; Windows line ends count as `\n`. */
export function readFrontmatter(text: string): { fields: unknown; body: string } | { problem: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) return { problem: "the file does not start with --- and its frontmatter" };
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length);
  // A file whose frontmatter ends the file has no line after the closing fence.
  const closing = end === -1 && normalized.endsWith(`\n${FENCE}`) ? normalized.length - FENCE.length - 1 : end;
  if (closing === -1) return { problem: "the frontmatter has no closing ---" };
  try {
    return { fields: parse(normalized.slice(FENCE.length + 1, closing + 1)), body: normalized.slice(closing + FENCE.length + 2) };
  } catch (err) {
    return { problem: `the frontmatter is not YAML: ${messageOf(err)}` };
  }
}
