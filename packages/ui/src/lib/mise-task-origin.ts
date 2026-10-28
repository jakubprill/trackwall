import type { MiseTask } from "@trackwall/protocol";

/**
 * Where a mise task of the repo's list is defined (ADR-110), as a short label next to its name and a sentence with the
 * file for the tooltip. Pure functions, tested in `test/mise-task-origin.test.ts`.
 */

export interface MiseTaskOriginLabel {
  label: string;
  /** `local`: only this clone has the mise task, so it stands out. */
  local: boolean;
  title: string;
}

/** `null` when the daemon does not know the origin: a label would claim more than it knows. */
export function miseTaskOriginLabel(task: Pick<MiseTask, "origin" | "source">): MiseTaskOriginLabel | null {
  const file = task.source ?? "a file mise did not name";
  switch (task.origin) {
    case "repo":
      return { label: "repo", local: false, title: `Defined in ${file}, which is in the repo's git` };
    case "local":
      return { label: "local", local: true, title: `Defined in ${file}, which git does not keep: only this clone has it` };
    case "outside":
      return { label: "outside repo", local: false, title: `Defined in ${file}, outside the repo` };
    case null:
      return null;
  }
}
