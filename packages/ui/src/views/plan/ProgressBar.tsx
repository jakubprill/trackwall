import type { BoardColumn } from "@trackwall/protocol";
import { type Progress, progressLabel } from "@/lib/plan-progress";
import { cn } from "@/lib/utils";

/** The share of each column that has a colour of its own: done, in review, in progress; the rest is the bar's ground. */
const SEGMENTS: readonly { column: BoardColumn; className: string }[] = [
  { column: "done", className: "bg-success" },
  { column: "review", className: "bg-warning" },
  { column: "in_progress", className: "bg-primary" },
];

/** A project's or an item's progress as a thin bar, with "2 of 9 done" as its accessible name. */
export function ProgressBar({ progress, className }: { progress: Progress; className?: string }) {
  const label = progressLabel(progress);
  if (label === undefined) return null;
  return (
    <span role="img" aria-label={label} title={label} className={cn("bg-secondary flex h-1.5 overflow-hidden rounded-full", className)}>
      {SEGMENTS.map(({ column, className: segment }) => (
        <span key={column} className={segment} style={{ width: `${(progress.byColumn[column] / progress.total) * 100}%` }} />
      ))}
    </span>
  );
}
