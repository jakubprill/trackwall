import { StatusLabel } from "@/components/StatusLabel";
import type { OutcomeMark } from "@/lib/task-outcomes";

/**
 * Whether a task is in review (ADR-213), its verdict and merge request (ADR-154), each with its story as a tooltip: on
 * its row in Sessions and on its card in Plan.
 */
export function TaskOutcomeMarks({ marks }: { marks: readonly OutcomeMark[] }) {
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
