import type { Task } from "@trackwall/protocol";
import { GitBranch } from "lucide-react";

/** Polecenie zadania w jednej linii, z ikoną gałęzi, żeby zadanie odróżniało się od sesji w korzeniu repo. */
export function TaskLine({ task }: { task: Task }) {
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs" title={task.branch}>
      <GitBranch className="size-3 shrink-0" aria-label="task in a worktree" />
      <span className="truncate">{task.prompt}</span>
    </span>
  );
}
