import type { Task } from "@trackwall/protocol";
import { GitBranch } from "lucide-react";

/** The task prompt on one line, with a branch icon so that a task stands apart from a session in a repo root. */
export function TaskLine({ task }: { task: Task }) {
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs" title={task.branch}>
      <GitBranch className="size-3 shrink-0" aria-label="task in a worktree" />
      <span className="truncate">{task.prompt}</span>
    </span>
  );
}
