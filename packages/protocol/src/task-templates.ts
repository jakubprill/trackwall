import { z } from "zod";
import { TaskPrompt, TaskTitle, visibleText } from "./agents.ts";
import { apiEndpoints, Done } from "./api.ts";
import { fileName } from "./approved-file.ts";

/**
 * Contract of the `task-templates` module (ADR-251): a task template is a prompt the user starts from in the New task
 * form, such as "Fix a failing test" or "Bump a dependency". Picking one only fills the prompt; the user reads it, fills
 * in its placeholders and starts the task as any other, so nothing in a template runs by itself and, unlike a routine
 * (ADR-173), it needs no approval. Trackwall ships a few built-in templates; the user's own ones, saved from the form,
 * lie as Markdown files in `.trackwall/task-templates` of the projects folder, and one with a built-in's name takes its
 * place. Every action is `POST /api/task-templates/<action>`.
 */

/** The template's name, also its file name without `.md`: lowercase words joined by `-`, made from its title. */
export const TASK_TEMPLATE_NAME_MAX = 60;
export const TaskTemplateName = fileName(TASK_TEMPLATE_NAME_MAX, "a task template name");
export type TaskTemplateName = z.infer<typeof TaskTemplateName>;

/**
 * A template as its file holds it. Title and prompt are checked like a routine's (`visibleText`) also when read from the
 * file, since anything with file tools in the projects folder can write it, and the user must see every character of
 * the prompt they start from.
 */
export const TaskTemplate = z.object({
  name: TaskTemplateName,
  title: visibleText(TaskTitle),
  /** The file's body below the frontmatter; may hold placeholders (`TEMPLATE_PLACEHOLDER`). */
  prompt: visibleText(TaskPrompt),
});
export type TaskTemplate = z.infer<typeof TaskTemplate>;

/** `built-in`: shipped with Trackwall; `own`: a file the user saved, which replaces a built-in of the same name. */
export const TaskTemplateOrigin = z.enum(["built-in", "own"]);
export type TaskTemplateOrigin = z.infer<typeof TaskTemplateOrigin>;

export const TaskTemplateEntry = TaskTemplate.extend({ origin: TaskTemplateOrigin });
export type TaskTemplateEntry = z.infer<typeof TaskTemplateEntry>;

/** A file of the templates folder the daemon could not read; the list goes on without it. */
export const TaskTemplateProblem = z.object({ file: z.string(), message: z.string() });
export type TaskTemplateProblem = z.infer<typeof TaskTemplateProblem>;

export const TaskTemplateList = z.object({
  /** The built-in ones first, in their order, each replaced in place by an own one of its name; then the own ones by name. */
  templates: z.array(TaskTemplateEntry),
  problems: z.array(TaskTemplateProblem),
});
export type TaskTemplateList = z.infer<typeof TaskTemplateList>;

/**
 * A placeholder in a template's prompt: lowercase words in angle brackets, such as `<test name>`, for the user to replace
 * before starting. Uppercase is left out so that code in a prompt (`List<String>`) is never taken for one.
 */
export const TEMPLATE_PLACEHOLDER = /<[a-z][a-z0-9 ,'-]{0,58}>/g;

/**
 * The name a template saved under `title` gets: its letters without accents, lowercased, words joined by `-`, cut to the
 * name's length; `undefined` when the title has no letter or digit a name can keep.
 */
export function taskTemplateNameOf(title: string): TaskTemplateName | undefined {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  let name = "";
  for (const word of words) {
    const next = name === "" ? word : `${name}-${word}`;
    if (next.length > TASK_TEMPLATE_NAME_MAX) break;
    name = next;
  }
  const parsed = TaskTemplateName.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}

/** The templates every workspace starts with: common work whose prompt says how a good result looks. */
export const BUILT_IN_TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    name: "fix-a-failing-test",
    title: "Fix a failing test",
    prompt:
      "The test <test name> fails. Find out why and fix the cause in the code; change the test only if the test itself is wrong, and say so. Run the test and the tests next to it to show they pass, and report what was wrong.",
  },
  {
    name: "fix-a-bug",
    title: "Fix a bug",
    prompt:
      "Bug: <what happens>. Expected: <what should happen>. Reproduce it in a test first and show the test fails, then fix the cause and show the test passes. Report the cause and the fix.",
  },
  {
    name: "bump-a-dependency",
    title: "Bump a dependency",
    prompt:
      "Update <dependency> to <version>. Read its release notes for breaking changes between the current version and that one, adapt the code that uses it, run the build and the tests, and report what changed and what is risky.",
  },
  {
    name: "add-tests",
    title: "Add tests",
    prompt:
      "Add tests for <class or module>. Cover its main behaviour and the edge cases you find in the code, in the repo's existing test style and tools. Do not change production code; if a test reveals a bug, leave the test failing and report the bug.",
  },
  {
    name: "refactor-without-changing-behaviour",
    title: "Refactor without changing behaviour",
    prompt:
      "Refactor <code to refactor> so that <goal, such as no duplicated logic>. Behaviour must not change: run the existing tests before and after, and where the code has none, add tests first.",
  },
  {
    name: "update-the-documentation",
    title: "Update the documentation",
    prompt:
      "Update the documentation of <feature or module> to match the code as it is now: the README, the docs and the comments that describe it. Do not change code. Report what was out of date.",
  },
  {
    name: "explain-how-it-works",
    title: "Explain how it works",
    prompt:
      "Explain how <feature or flow> works in this repo: where it starts, the main classes and files, and how data flows through them. Do not change any file; give the explanation in your report.",
  },
];

/** What the user saves: the name comes from the title (`taskTemplateNameOf`). */
export const TaskTemplateDraft = z.object({ title: visibleText(TaskTitle), prompt: visibleText(TaskPrompt) }).strict();
export type TaskTemplateDraft = z.infer<typeof TaskTemplateDraft>;

const endpoint = apiEndpoints("task-templates");

export const taskTemplatesApi = {
  /** The built-in templates and the user's own; `projects_dir_unavailable` or `bad_request` without a projects folder. */
  list: endpoint("list", z.object({}).strict(), TaskTemplateList),
  /** Saves the user's own template under the name its title gives, replacing one of that name (also a built-in one). */
  save: endpoint("save", TaskTemplateDraft, TaskTemplateEntry),
  /** Removes the user's own template; a built-in one it replaced shows again. */
  remove: endpoint("remove", z.object({ name: TaskTemplateName }).strict(), Done),
};
