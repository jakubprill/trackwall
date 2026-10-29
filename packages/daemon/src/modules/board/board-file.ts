import { BoardItem } from "@trackwall/protocol";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { messageOf } from "../../infra/errors.ts";

/**
 * One board item as a file (ADR-133): `<id>.md`, YAML frontmatter with the item's fields and the body as Markdown below
 * it, so the user can read and edit an item in any editor and a diff shows what changed. The folder lies in the projects
 * folder, where an agent with file tools can write too, so a file is read through the item's schema, and one that fails
 * is a problem of the board, never an item.
 */

const FENCE = "---";

/** The frontmatter: every field but the body. Unknown keys are dropped, and the next write leaves them out. */
const Frontmatter = BoardItem.omit({ body: true });

export function itemFileName(id: string): string {
  return `${id}.md`;
}

/** The item's id from its file name; `undefined` for any other file, which the board does not read. */
export function itemIdOfFile(name: string): string | undefined {
  const id = name.endsWith(".md") ? name.slice(0, -".md".length) : undefined;
  return id !== undefined && z.uuid().safeParse(id).success ? id : undefined;
}

export function writeItemFile(item: BoardItem): string {
  const { body, ...fields } = item;
  return `${FENCE}\n${stringify(fields)}${FENCE}\n${body}`;
}

/** The item a file holds, or why it holds none; `id` is the one its name gives, which the frontmatter must repeat. */
export function readItemFile(id: string, text: string): { item: BoardItem } | { problem: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) return { problem: "the file does not start with --- and its frontmatter" };
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length);
  // A file whose frontmatter ends the file has no line after the closing fence.
  const closing = end === -1 && normalized.endsWith(`\n${FENCE}`) ? normalized.length - FENCE.length - 1 : end;
  if (closing === -1) return { problem: "the frontmatter has no closing ---" };
  let fields: unknown;
  try {
    fields = parse(normalized.slice(FENCE.length + 1, closing + 1));
  } catch (err) {
    return { problem: `the frontmatter is not YAML: ${messageOf(err)}` };
  }
  const parsed = Frontmatter.safeParse(fields);
  if (!parsed.success) return { problem: z.prettifyError(parsed.error) };
  if (parsed.data.id !== id) return { problem: `the frontmatter names item ${parsed.data.id}, not the file's ${id}` };
  return { item: { ...parsed.data, body: normalized.slice(closing + FENCE.length + 2) } };
}
