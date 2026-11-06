import type { TaskOutcome } from "@trackwall/protocol";
import { StatusLabel } from "@/components/StatusLabel";
import { outcomeMarks } from "@/lib/task-outcomes";

/**
 * Whether a task is in review (ADR-213), its verdict and merge request on its row in the Sessions list (ADR-154), each
 * with its story as a tooltip.
 */
export function TaskOutcomeMarks({ outcome, inReview }: { outcome: TaskOutcome | undefined; inReview: boolean }) {
  const marks = outcomeMarks(outcome, inReview);
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
