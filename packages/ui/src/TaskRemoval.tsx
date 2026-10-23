import { agentsApi, type SessionList, type Task } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorCode, errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";

/**
 * Zakończenie zadania (ADR-31): worktree znika, a gałąź zostaje albo znika razem z nim. Daemon sam odmawia, gdy
 * przepadłyby zmiany (`unsaved_changes`), i dopiero wtedy panel pyta, czy usunąć mimo to, z tym, co przepadnie.
 */
export function TaskRemoval({
  conn,
  task,
  onRemoved,
  onCancel,
}: {
  conn: Connection;
  task: Task;
  onRemoved: (list: SessionList) => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [refusal, setRefusal] = useState<{ keepBranch: boolean; message: string }>();

  const remove = (keepBranch: boolean, discardChanges: boolean) => {
    setPending(true);
    setError(undefined);
    post(conn, agentsApi.removeTask, { task: task.id, keepBranch, discardChanges })
      .then(onRemoved, (err: unknown) => {
        if (errorCode(err) === "unsaved_changes") setRefusal({ keepBranch, message: errorMessage(err) });
        else setError(errorMessage(err));
      })
      .finally(() => setPending(false));
  };

  return (
    <div role="alertdialog" aria-label="Zakończ zadanie" className="bg-card flex flex-col gap-3 border-b px-4 py-3">
      {refusal ? (
        <>
          <p className="text-warning text-sm">
            Uwaga: {refusal.message}. Zacommituj je w VS Code albo usuń mimo to; tego nie da się cofnąć.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" disabled={pending} onClick={() => remove(refusal.keepBranch, true)}>
              Usuń mimo to
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
              Anuluj
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Worktree zadania zniknie z dysku. Gałąź <span className="text-foreground font-mono">{task.branch}</span> możesz zostawić, żeby
            ją wypchnąć albo scalić później.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => remove(true, false)}>
              Zostaw gałąź, usuń worktree
            </Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={() => remove(false, false)}>
              Usuń gałąź i worktree
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
              Anuluj
            </Button>
          </div>
        </>
      )}
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
    </div>
  );
}
