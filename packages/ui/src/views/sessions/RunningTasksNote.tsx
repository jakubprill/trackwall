import type { RunningTasksWarningState, Session } from "@trackwall/protocol";
import { TriangleAlert } from "lucide-react";
import { runningTasksWarningNote } from "@/lib/running-tasks-warning";

/**
 * The warning under the start options of the New session form and the task proposals when the start would make more
 * tasks run at once than this computer is set to warn above (ADR-244). Only a warning: the start button stays.
 */
export function RunningTasksNote({
  sessions,
  warning,
  starting,
}: {
  sessions: readonly Session[];
  warning: RunningTasksWarningState | undefined;
  /** How many tasks the start would add. */
  starting: number;
}) {
  const note = runningTasksWarningNote(sessions, warning, starting);
  if (note === null) return null;
  return (
    <p role="status" className="text-warning flex max-w-prose items-start gap-1.5 text-xs">
      <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{note}</span>
    </p>
  );
}
