import { agentsApi, type Task } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorCode, errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/** The daemon's refusal with what would be lost, and the branch choice the request has to be repeated with. */
interface Refusal {
  keepBranch: boolean;
  message: string;
}

/**
 * Removing a task (ADR-31): the worktree goes together with the files git ignores, and the branch stays or goes
 * with it. The daemon itself refuses when changes would be lost (`unsaved_changes`), and only then does the panel ask
 * whether to remove it anyway, showing what will be lost.
 */
export function TaskRemoval({
  conn,
  task,
  onRemoved,
  onCancel,
}: {
  conn: Connection;
  task: Task;
  onRemoved: () => void;
  onCancel: () => void;
}) {
  const [refusal, setRefusal] = useState<Refusal>();
  // A refusal is a result, not an error: it turns the buttons into the question whether to remove anyway.
  const remove = useAction(
    (keepBranch: boolean, discardChanges: boolean) =>
      post(conn, agentsApi.removeTask, { task: task.id, keepBranch, discardChanges }).then(
        (): Refusal | undefined => undefined,
        (err: unknown) => {
          if (errorCode(err) === "unsaved_changes") return { keepBranch, message: errorMessage(err) };
          throw err;
        },
      ),
    (refused) => (refused ? setRefusal(refused) : onRemoved()),
  );

  return (
    <div role="alertdialog" aria-label="End task" className="bg-card flex flex-col gap-3 border-b px-4 py-3">
      {refusal ? (
        <>
          <p className="text-warning text-sm">
            Warning: {refusal.message}. If you want to keep it, cancel and deal with it in VS Code; removing anyway cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" disabled={remove.pending} onClick={() => remove.run(refusal.keepBranch, true)}>
              Remove anyway
            </Button>
            <Button variant="ghost" size="sm" disabled={remove.pending} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            The task's worktree will be deleted along with files git ignores (such as dependencies and build output). You can keep the
            branch <span className="text-foreground font-mono">{task.branch}</span> to push or merge it later.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={remove.pending} onClick={() => remove.run(true, false)}>
              Keep branch, remove worktree
            </Button>
            <Button variant="destructive" size="sm" disabled={remove.pending} onClick={() => remove.run(false, false)}>
              Remove branch and worktree
            </Button>
            <Button variant="ghost" size="sm" disabled={remove.pending} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {remove.error && <p className="text-destructive text-sm whitespace-pre-wrap">{remove.error}</p>}
    </div>
  );
}
