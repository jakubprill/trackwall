import {
  BUILT_IN_TASK_TEMPLATES,
  type TaskTemplate,
  type TaskTemplateDraft,
  type TaskTemplateEntry,
  type TaskTemplateList,
  type TaskTemplateName,
  taskTemplateNameOf,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { NamedFileFolder } from "../../infra/named-file-folder.ts";
import { ensureTrackwallDir } from "../../infra/trackwall-dir.ts";
import { TASK_TEMPLATE_FILE_FORMAT, writeTaskTemplateFile } from "./task-template-file.ts";

/**
 * Task templates (ADR-251, §4.28): prompts the user starts a task from in the New task form. The built-in ones come
 * from `protocol`; the user's own lie as files in `.trackwall/task-templates` of the projects folder, read on every
 * list, and one with a built-in's name takes its place. A template only fills the form's prompt, which the user reads
 * before starting, so unlike a routine nothing here needs an approval, and nothing here starts a task.
 */

/** Own templates the user may save, below the files read, so the list never stops reading the user's own. */
const MAX_OWN_TEMPLATES = 100;

export interface TaskTemplatesDeps {
  /** The projects folder; refused (`bad_request`, `projects_dir_unavailable`) when it is not set or not there. */
  projectsDir: () => Promise<string>;
}

export class TaskTemplates {
  readonly #folder: NamedFileFolder<TaskTemplate>;

  constructor(deps: TaskTemplatesDeps) {
    this.#folder = new NamedFileFolder(TASK_TEMPLATE_FILE_FORMAT, async () =>
      ensureTrackwallDir(await deps.projectsDir(), "task-templates"),
    );
  }

  async list(): Promise<TaskTemplateList> {
    const { files, problems } = await this.#folder.list();
    return { templates: merged(files.map((f) => f.value)), problems };
  }

  /** Saves the user's own template under the name its title gives, replacing the one of that name. */
  async save(template: TaskTemplateDraft): Promise<TaskTemplateEntry> {
    const name = taskTemplateNameOf(template.title);
    if (name === undefined) throw new DomainError("bad_request", "a template's title needs at least one letter or digit");
    const { files } = await this.#folder.list();
    if (!files.some((f) => f.name === name) && files.length >= MAX_OWN_TEMPLATES)
      throw new DomainError("bad_request", `${MAX_OWN_TEMPLATES} templates are saved, the limit; remove some first`);
    const saved = { name, ...template };
    await this.#folder.write(name, writeTaskTemplateFile(saved));
    return { ...saved, origin: "own" };
  }

  remove(name: TaskTemplateName): Promise<void> {
    return this.#folder.remove(name);
  }
}

/** The built-in templates in their order, each replaced in place by an own one of its name, then the other own ones. */
function merged(own: readonly TaskTemplate[]): TaskTemplateEntry[] {
  const byName = new Map(own.map((t) => [t.name, t]));
  const builtIn = BUILT_IN_TASK_TEMPLATES.map((t): TaskTemplateEntry => {
    const replacing = byName.get(t.name);
    return replacing ? { ...replacing, origin: "own" } : { ...t, origin: "built-in" };
  });
  const builtInNames = new Set(BUILT_IN_TASK_TEMPLATES.map((t) => t.name));
  const rest = own.filter((t) => !builtInNames.has(t.name)).map((t): TaskTemplateEntry => ({ ...t, origin: "own" }));
  return [...builtIn, ...rest];
}
