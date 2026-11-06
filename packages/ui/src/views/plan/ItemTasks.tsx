import { GitBranch } from "lucide-react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { ItemTask } from "@/lib/plan-progress";

/**
 * The tasks started on an item as cards (ADR-215): the task, its repo, what its newest session is doing, its review,
 * verdict and merge request, and "Open" to go to it in Sessions; "Start task" below them, then the tasks started on the
 * items it is split into.
 */
export function ItemTasks({
  tasks,
  below,
  onStartTask,
  onOpenTask,
}: {
  tasks: readonly ItemTask[];
  /** The tasks started on the items it is split into, so a business item shows the work under it. */
  below: readonly ItemTask[];
  onStartTask: () => void;
  onOpenTask: (task: string) => void;
}) {
  return (
    <section aria-label="Tasks" className="flex flex-col gap-2">
      <h4 className="hud-label">Tasks</h4>
      {tasks.length === 0 && <p className="text-muted-foreground text-xs">No task started on it yet.</p>}
      <TaskCards tasks={tasks} onOpenTask={onOpenTask} />
      <Button className="w-fit" onClick={onStartTask}>
        <GitBranch /> Start task
      </Button>
      {below.length > 0 && (
        <>
          <h4 className="hud-label pt-2">Tasks below</h4>
          <TaskCards tasks={below} onOpenTask={onOpenTask} />
        </>
      )}
    </section>
  );
}

function TaskCards({ tasks, onOpenTask }: { tasks: readonly ItemTask[]; onOpenTask: (task: string) => void }) {
  if (tasks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {tasks.map(({ task, state, marks, waitsForYou }) => (
        <li key={task.id} className="bg-card flex flex-col gap-1 rounded-md border px-3 py-2">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-sm break-words">{task.title ?? task.prompt.split("\n")[0]}</span>
            <Button variant="outline" size="sm" onClick={() => onOpenTask(task.id)}>
              Open
            </Button>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-mono">{task.repo}</span>
            <StatusLabel tone={waitsForYou ? "warning" : state.tone} label={state.label} />
            {marks.map((mark) => (
              <span key={mark.key} title={mark.title}>
                <StatusLabel tone={mark.tone} label={mark.label} />
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
