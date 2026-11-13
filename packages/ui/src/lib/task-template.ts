import { type TaskTemplateEntry, TEMPLATE_PLACEHOLDER, taskTemplateNameOf } from "@trackwall/protocol";

/**
 * How a task template fills the New task form's prompt (ADR-251): what the prompt becomes when one is picked, which part
 * the cursor selects so the user types over the first placeholder, and which of its placeholders are still unfilled.
 */

/** A range of the prompt to select, as `setSelectionRange` takes it. */
export interface PromptSelection {
  start: number;
  end: number;
}

/**
 * The prompt after picking a template whose prompt is `template`. An empty prompt, or one still exactly the template
 * picked before (`picked`), is replaced; anything the user wrote is kept, and the template goes below it after a blank
 * line. The selection is the template's first placeholder, `null` when it has none.
 */
export function promptWithTemplate(
  current: string,
  picked: string | null,
  template: string,
): { prompt: string; selection: PromptSelection | null } {
  const replaces = current.trim() === "" || current === picked;
  const kept = replaces ? "" : `${current.trimEnd()}\n\n`;
  const prompt = `${kept}${template}`;
  return { prompt, selection: placeholderFrom(prompt, kept.length) };
}

/** The template's placeholders the prompt still holds, each once, in the template's order. */
export function placeholdersLeft(prompt: string, template: string | null): string[] {
  if (template === null) return [];
  const own = new Set(template.match(TEMPLATE_PLACEHOLDER) ?? []);
  return [...own].filter((placeholder) => prompt.includes(placeholder));
}

/** The first placeholder at or after `from`. */
function placeholderFrom(prompt: string, from: number): PromptSelection | null {
  for (const match of prompt.matchAll(TEMPLATE_PLACEHOLDER)) {
    if (match.index >= from) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

/** What saving the prompt as a template under `title` does: makes a new one, replaces one, or cannot (no usable title). */
export type TemplateSave =
  | { kind: "new"; name: string }
  | { kind: "replaces"; name: string; template: TaskTemplateEntry }
  | { kind: "needs-title" };

export function templateSave(title: string, templates: readonly TaskTemplateEntry[]): TemplateSave {
  const name = taskTemplateNameOf(title);
  if (name === undefined) return { kind: "needs-title" };
  const template = templates.find((t) => t.name === name);
  return template ? { kind: "replaces", name, template } : { kind: "new", name };
}
