import { actionIsNewer } from "./use-remote.ts";

/** A task the user has just ended, hidden until a list sent after `afterLoad` arrives. */
export interface TaskHide {
  task: string;
  afterLoad: number;
}

/** The hides that no list loaded since covers yet; several tasks can be ended before the next list arrives. */
export function activeHides(hides: readonly TaskHide[], loadNumber: number | undefined): TaskHide[] {
  return hides.filter((hide) => actionIsNewer(hide.afterLoad, loadNumber));
}
