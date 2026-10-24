import { countLabel, type DroppedFolder, type NounForms } from "@trackwall/protocol";

const REPOS: NounForms = { one: "git repo", other: "git repos" };

/**
 * What the window does with a folder dropped outside a session (ADR-51): open a repo that is already listed, or say
 * what the folder is and, when it has repos, offer it (or the folder that holds the dropped repo) as the projects
 * folder. Trackwall lists the repos of one folder (ADR-18), so a repo from somewhere else comes in with its folder.
 */
/** What a drag over the window can do; shown while dragging and after a file dropped outside a session. */
export const DROP_HINT =
  "Drop a file on a session terminal to paste its path, or a folder anywhere else to open it in Repos or use it as the projects folder.";

export type DropOutcome = { kind: "open-repos"; repo?: string } | DropPrompt;

export interface DropPrompt {
  kind: "prompt";
  message: string;
  /** The folder the prompt offers as the projects folder, with its button label. */
  projectsDir?: { path: string; label: string };
}

export function dropOutcome(folder: DroppedFolder): DropOutcome {
  switch (folder.kind) {
    case "listed-repo":
      return { kind: "open-repos", repo: folder.repo };
    case "projects-dir":
      return { kind: "open-repos" };
    case "folder-with-repos":
      return {
        kind: "prompt",
        message: `${folder.path} has ${countLabel(folder.repos, REPOS)} directly inside it. Use it as the projects folder? The Repos view then lists its repos instead of the current ones.`,
        projectsDir: { path: folder.path, label: "Use as the projects folder" },
      };
    case "repo-elsewhere":
      return {
        kind: "prompt",
        message: `${folder.path} is not in the projects folder. Trackwall lists the repos directly inside one folder; the folder that holds this repo, ${folder.parent}, has ${countLabel(folder.parentRepos, REPOS)}.`,
        projectsDir: { path: folder.parent, label: "Use its folder as the projects folder" },
      };
    case "hidden-repo":
      return {
        kind: "prompt",
        message: `${folder.path} is in the projects folder, but its name starts with a dot, and the Repos view skips such folders. Rename it to list it.`,
      };
    case "no-repos":
      return { kind: "prompt", message: `${folder.path} is not a git repo and has no git repos directly inside it.` };
    case "file":
      return {
        kind: "prompt",
        message: `${folder.path} is a file. ${DROP_HINT}`,
      };
  }
}

/** Only the first dropped item is used outside a session; the rest would each need their own question. */
export function extraItemsNote(paths: readonly string[]): string | undefined {
  const extra = paths.length - 1;
  return extra > 0
    ? `Only the first dropped item is used; ${countLabel(extra, { one: "other was", other: "others were" })} left out.`
    : undefined;
}
