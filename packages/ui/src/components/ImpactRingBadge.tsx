import type { ImpactedRepo } from "@trackwall/protocol";
import { Badge } from "@/components/ui/badge";
import { MAYBE_REACHED } from "@/lib/task-impact";
import { cn } from "@/lib/utils";

/**
 * A reached repo's ring in a task's impact (ADR-147), the same in the task's Impact tab and on the Overview: ring 1 in
 * the colour of danger, further rings in that of a warning, dashed with "maybe" when it may not be reached.
 */
export function ImpactRingBadge({ reached }: { reached: Pick<ImpactedRepo, "ring" | "sure"> }) {
  return (
    <Badge
      variant={reached.ring === 1 ? "destructive" : "outline"}
      className={cn(reached.ring > 1 && "border-warning/40 text-warning", !reached.sure && "border-dashed")}
      title={reached.sure ? undefined : MAYBE_REACHED}
    >
      {`ring ${reached.ring}${reached.sure ? "" : " · maybe"}`}
    </Badge>
  );
}
