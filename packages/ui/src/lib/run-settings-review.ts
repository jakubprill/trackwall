import type { TaskRunSettings } from "@trackwall/protocol";

/**
 * Whether the user can accept the changed git settings of a task's repo they review (ADR-181 addendum): never while a
 * change can make git run a program Trackwall does not check (`blocked`, to be undone in the repo), and only after they say
 * they read in the repo what the review does not show (`hidden`: too long, or a credential).
 */
export function runSettingsAcceptance(
  review: TaskRunSettings,
  readHidden: boolean,
): { canAccept: boolean; blocked: string[]; hidden: string[] } {
  const blocked = review.changes.filter((c) => !c.acceptable).map((c) => c.place);
  const hidden = review.changes.filter((c) => c.change !== "removed" && c.content === null).map((c) => c.place);
  return { canAccept: blocked.length === 0 && (hidden.length === 0 || readHidden), blocked, hidden };
}
