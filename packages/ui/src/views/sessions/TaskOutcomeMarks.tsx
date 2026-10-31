import type { TaskOutcome } from "@trackwall/protocol";
import { StatusLabel } from "@/components/StatusLabel";
import { outcomeMarks } from "@/lib/task-outcomes";

/** A task's verdict and merge request on its row in the Sessions list (ADR-154), each with its story as a tooltip. */
export function TaskOutcomeMarks({ outcome }: { outcome: TaskOutcome | undefined }) {
  const marks = outcomeMarks(outcome);
  if (marks.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {marks.map((mark) => (
        <span key={mark.key} title={mark.title}>
          <StatusLabel tone={mark.tone} label={mark.label} />
        </span>
      ))}
    </span>
  );
}
