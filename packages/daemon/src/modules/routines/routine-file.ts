import { Routine, RoutineName } from "@trackwall/protocol";
import { z } from "zod";
import { readFrontmatter, writeFrontmatter } from "../../infra/frontmatter.ts";
import type { FolderFormat } from "../../infra/named-file-folder.ts";

/**
 * One routine as a file (ADR-173): `<name>.md`, YAML frontmatter with the title, repo, model and approvals mode, and the
 * prompt as the body, so the user reads and reviews it in any editor. The file is read through the routine's schema,
 * and one that fails is a problem of the list, never a routine.
 */

const EXTENSION = ".md";
/** The frontmatter: the routine without its name (the file's) and prompt (the body). */
const Frontmatter = Routine.omit({ name: true, prompt: true });

/** The routine's name from its file name; `undefined` for any other file, which the list does not read. */
export function routineNameOfFile(file: string): RoutineName | undefined {
  if (!file.endsWith(EXTENSION)) return undefined;
  const name = RoutineName.safeParse(file.slice(0, -EXTENSION.length));
  return name.success ? name.data : undefined;
}

export function writeRoutineFile({ name: _, prompt, ...fields }: Routine): string {
  return writeFrontmatter(fields, `${prompt}\n`);
}

/** The routine a file holds, or why it holds none. Keys the frontmatter must not set (`name`, `prompt`) are dropped. */
export function readRoutineFile(name: RoutineName, text: string): { routine: Routine } | { problem: string } {
  const file = readFrontmatter(text);
  if ("problem" in file) return file;
  const fields = Frontmatter.safeParse(file.fields);
  if (!fields.success) return { problem: z.prettifyError(fields.error) };
  // The body ends with the line break `writeRoutineFile` adds; `TaskPrompt` trims it.
  const prompt = Routine.shape.prompt.safeParse(file.body);
  if (!prompt.success) return { problem: `the prompt: ${z.prettifyError(prompt.error)}` };
  return { routine: { ...fields.data, name, prompt: prompt.data } };
}

/** How the routines folder is read: a prompt of `TASK_PROMPT_MAX` characters in any script fits in 64 KB with its frontmatter. */
export const ROUTINE_FILE_FORMAT: FolderFormat<Routine> = {
  what: "routine",
  name: RoutineName,
  extension: EXTENSION,
  nameOfFile: routineNameOfFile,
  read: (name, text) => {
    const file = readRoutineFile(name, text);
    return "problem" in file ? file : { value: file.routine };
  },
  maxFileBytes: 64 * 1024,
  maxFiles: 200,
};
