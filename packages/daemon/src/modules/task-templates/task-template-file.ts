import { TaskTemplate, TaskTemplateName } from "@trackwall/protocol";
import { z } from "zod";
import { readFrontmatter, writeFrontmatter } from "../../infra/frontmatter.ts";
import type { FolderFormat } from "../../infra/named-file-folder.ts";

/**
 * One of the user's own task templates as a file (ADR-251): `<name>.md`, YAML frontmatter with the title and the prompt
 * as the body, so the user can also write or edit one in any editor. The file is read through the template's schema,
 * and one that fails is a problem of the list, never a template.
 */

const EXTENSION = ".md";
const Frontmatter = TaskTemplate.pick({ title: true });

export function writeTaskTemplateFile({ title, prompt }: TaskTemplate): string {
  return writeFrontmatter({ title }, `${prompt}\n`);
}

/** The template a file holds, or why it holds none. Keys other than the title are dropped. */
export function readTaskTemplateFile(name: TaskTemplateName, text: string): { template: TaskTemplate } | { problem: string } {
  const file = readFrontmatter(text);
  if ("problem" in file) return file;
  const fields = Frontmatter.safeParse(file.fields);
  if (!fields.success) return { problem: z.prettifyError(fields.error) };
  // The body ends with the line break `writeTaskTemplateFile` adds; `TaskPrompt` trims it.
  const prompt = TaskTemplate.shape.prompt.safeParse(file.body);
  if (!prompt.success) return { problem: `the prompt: ${z.prettifyError(prompt.error)}` };
  return { template: { name, title: fields.data.title, prompt: prompt.data } };
}

/** How the templates folder is read: a prompt of `TASK_PROMPT_MAX` characters in any script fits in 64 KB with its title. */
export const TASK_TEMPLATE_FILE_FORMAT: FolderFormat<TaskTemplate> = {
  what: "task template",
  name: TaskTemplateName,
  extension: EXTENSION,
  nameOfFile: (file) => {
    if (!file.endsWith(EXTENSION)) return undefined;
    const name = TaskTemplateName.safeParse(file.slice(0, -EXTENSION.length));
    return name.success ? name.data : undefined;
  },
  read: (name, text) => {
    const file = readTaskTemplateFile(name, text);
    return "problem" in file ? file : { value: file.template };
  },
  maxFileBytes: 64 * 1024,
  maxFiles: 200,
};
