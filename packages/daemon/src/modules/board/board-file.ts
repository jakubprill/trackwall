import { BoardItem } from "@trackwall/protocol";
import { z } from "zod";
import { readFrontmatter, writeFrontmatter } from "../../infra/frontmatter.ts";

/**
 * One board item as a file (ADR-133): `<id>.md`, YAML frontmatter with the item's fields and the body as Markdown below
 * it, so the user can read and edit an item in any editor and a diff shows what changed. The folder lies in the projects
 * folder, where an agent with file tools can write too, so a file is read through the item's schema, and one that fails
 * is a problem of the board, never an item.
 */

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
  return writeFrontmatter(fields, body);
}

/** The item a file holds, or why it holds none; `id` is the one its name gives, which the frontmatter must repeat. */
export function readItemFile(id: string, text: string): { item: BoardItem } | { problem: string } {
  const file = readFrontmatter(text);
  if ("problem" in file) return file;
  const parsed = Frontmatter.safeParse(file.fields);
  if (!parsed.success) return { problem: z.prettifyError(parsed.error) };
  if (parsed.data.id !== id) return { problem: `the frontmatter names item ${parsed.data.id}, not the file's ${id}` };
  const body = BoardItem.shape.body.safeParse(file.body);
  if (!body.success) return { problem: z.prettifyError(body.error) };
  return { item: { ...parsed.data, body: body.data } };
}
