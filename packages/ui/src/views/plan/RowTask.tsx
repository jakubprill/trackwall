import { StatusLabel } from "@/components/StatusLabel";
import { type ItemTask, rowTask } from "@/lib/plan-progress";

/** A task's state and outcome on a row or a card (one waiting for the user first), with how many more tasks the item has. */
export function RowTask({ tasks }: { tasks: readonly ItemTask[] }) {
  const shown = rowTask(tasks);
  if (!shown) return null;
  const words = [shown.state.label, ...shown.marks.map((mark) => mark.label)];
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs" title={shown.marks.map((mark) => mark.title).join("\n") || undefined}>
      <StatusLabel tone={shown.waitsForYou ? "warning" : shown.state.tone} label={words.join(" · ")} />
      {tasks.length > 1 && <span className="text-muted-foreground">+{tasks.length - 1}</span>}
    </span>
  );
}
