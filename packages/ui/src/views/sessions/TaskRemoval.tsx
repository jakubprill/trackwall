import { agentsApi, type TaskRunSettings as RunSettingsReview, type Task } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorCode, errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { TaskRunSettings } from "./TaskRunSettings.tsx";

/** The daemon's refusal with what would be lost, and the branch choice the request has to be repeated with. */
interface Refusal {
  keepBranch: boolean;
  message: string;
}

/** What the panel shows instead of its buttons: a refusal to confirm, or the changed git settings to review (ADR-181 addendum). */
type Shown = { kind: "refusal"; refusal: Refusal } | { kind: "run-settings"; review: RunSettingsReview } | { kind: "accepted" };

/**
 * Ending a task (ADR-31): the worktree goes together with the files git ignores, and the branch stays or goes
 * with it. The daemon itself refuses when changes would be lost (`unsaved_changes`), and only then does the panel ask
 * whether to end it anyway, showing what will be lost. From a comparison (ADR-252) it ends the attempt the user did
 * not keep, and names the kept one, which the task journal records.
 */
export function TaskRemoval({
  conn,
  task,
  keptInstead,
  onRemoved,
  onCancel,
}: {
  conn: Connection;
  task: Task;
  /** The other attempt at the same task the user keeps instead of this one. */
  keptInstead?: Task;
  onRemoved: () => void;
  onCancel: () => void;
}) {
  const [shown, setShown] = useState<Shown>();
  const refusal = shown?.kind === "refusal" ? shown.refusal : undefined;
  // A refusal is a result, not an error: it turns the buttons into the question whether to end it anyway. So are git
  // settings that changed under a task in the sandbox: the user reviews them here, or the task could never end.
  const remove = useAction(
    (keepBranch: boolean, discardChanges: boolean) =>
      post(conn, agentsApi.removeTask, { task: task.id, keepBranch, discardChanges, keptInstead: keptInstead?.id }).then(
        (): Shown | undefined => undefined,
        async (err: unknown): Promise<Shown> => {
          if (errorCode(err) === "unsaved_changes") return { kind: "refusal", refusal: { keepBranch, message: errorMessage(err) } };
          const review = await post(conn, agentsApi.taskRunSettings, { task: task.id }).catch(() => undefined);
          if (review && !review.matches) return { kind: "run-settings", review };
          throw err;
        },
      ),
    (next) => (next ? setShown(next) : onRemoved()),
  );

  if (shown?.kind === "run-settings")
    return (
      <div
        role="alertdialog"
        aria-label={keptInstead ? "End the other attempt" : "End task"}
        className="bg-card flex flex-col gap-3 border-b px-4 py-3"
      >
        <TaskRunSettings
          conn={conn}
          task={task.id}
          review={shown.review}
          onAccepted={() => setShown({ kind: "accepted" })}
          onCancel={onCancel}
        />
      </div>
    );

  return (
    <div
      role="alertdialog"
      aria-label={keptInstead ? "End the other attempt" : "End task"}
      className="bg-card flex flex-col gap-3 border-b px-4 py-3"
    >
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
          {shown?.kind === "accepted" && <p className="text-sm">Accepted: git runs in this repo again, so the task can end now.</p>}
          {keptInstead && (
            <p className="text-sm">
              Keep <span className="font-mono">{keptInstead.branch}</span> and end the other attempt,{" "}
              <span className="font-mono">{task.branch}</span>.
            </p>
          )}
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
