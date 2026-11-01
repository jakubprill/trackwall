import { KnowledgeEntry, KnowledgeName } from "@trackwall/protocol";
import { z } from "zod";
import type { ApprovedFolderFormat } from "../../infra/approved-folder.ts";
import { readFrontmatter, writeFrontmatter } from "../../infra/frontmatter.ts";

/**
 * One entry of workspace knowledge as a file (ADR-170): `<name>.md`, YAML frontmatter with the kind, repos, evidence,
 * writer and time, and the fact as the body, so the user reads and edits it in any editor. The file is read through the
 * entry's schema, and one that fails is a problem of the list, never an entry.
 */

const EXTENSION = ".md";
/** The frontmatter: the entry without its name (the file's) and text (the body). */
const Frontmatter = KnowledgeEntry.omit({ name: true, text: true });

/** The entry's name from its file name; `undefined` for any other file, which the list does not read. */
export function knowledgeNameOfFile(file: string): KnowledgeName | undefined {
  if (!file.endsWith(EXTENSION)) return undefined;
  const name = KnowledgeName.safeParse(file.slice(0, -EXTENSION.length));
  return name.success ? name.data : undefined;
}

export function writeKnowledgeFile({ name: _, text, ...fields }: KnowledgeEntry): string {
  return writeFrontmatter(fields, `${text}\n`);
}

/** The entry a file holds, or why it holds none. Keys the frontmatter must not set (`name`, `text`) are dropped. */
export function readKnowledgeFile(name: KnowledgeName, text: string): { entry: KnowledgeEntry } | { problem: string } {
  const file = readFrontmatter(text);
  if ("problem" in file) return file;
  const fields = Frontmatter.safeParse(file.fields);
  if (!fields.success) return { problem: z.prettifyError(fields.error) };
  // The body ends with the line break `writeKnowledgeFile` adds; `KnowledgeText` trims it.
  const body = KnowledgeEntry.shape.text.safeParse(file.body);
  if (!body.success) return { problem: `the text: ${z.prettifyError(body.error)}` };
  return { entry: { ...fields.data, name, text: body.data } };
}

/** How the knowledge folder is read: an entry is two short texts, so 16 KB is plenty in any script. */
export const KNOWLEDGE_FILE_FORMAT: ApprovedFolderFormat<KnowledgeEntry> = {
  what: "knowledge entry",
  extension: EXTENSION,
  nameOfFile: knowledgeNameOfFile,
  read: (name, text) => {
    const file = readKnowledgeFile(name, text);
    return "problem" in file ? file : { value: file.entry };
  },
  maxFileBytes: 16 * 1024,
  maxFiles: 500,
};
