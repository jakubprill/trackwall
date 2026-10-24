import { agentsApi, type Task } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorCode, errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/** Odmowa daemona z tym, co by przepadło, i wyborem gałęzi, z którym trzeba powtórzyć żądanie. */
interface Refusal {
  keepBranch: boolean;
  message: string;
}

/**
 * Zakończenie zadania (ADR-31): worktree znika razem z plikami ignorowanymi przez gita, a gałąź zostaje albo znika
 * razem z nim. Daemon sam odmawia, gdy przepadłyby zmiany (`unsaved_changes`), i dopiero wtedy panel pyta, czy
 * usunąć mimo to, z tym, co przepadnie.
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
  // Odmowa to wynik, a nie błąd: zamienia przyciski na pytanie, czy usunąć mimo to.
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
    <div role="alertdialog" aria-label="Zakończ zadanie" className="bg-card flex flex-col gap-3 border-b px-4 py-3">
      {refusal ? (
        <>
          <p className="text-warning text-sm">
            Uwaga: {refusal.message}. Zacommituj je w VS Code albo usuń mimo to; tego nie da się cofnąć.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" disabled={remove.pending} onClick={() => remove.run(refusal.keepBranch, true)}>
              Usuń mimo to
            </Button>
            <Button variant="ghost" size="sm" disabled={remove.pending} onClick={onCancel}>
              Anuluj
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Worktree zadania zniknie z dysku razem z plikami ignorowanymi przez gita (np. zależnościami i wynikami buildu). Gałąź{" "}
            <span className="text-foreground font-mono">{task.branch}</span> możesz zostawić, żeby ją wypchnąć albo scalić później.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={remove.pending} onClick={() => remove.run(true, false)}>
              Zostaw gałąź, usuń worktree
            </Button>
            <Button variant="destructive" size="sm" disabled={remove.pending} onClick={() => remove.run(false, false)}>
              Usuń gałąź i worktree
            </Button>
            <Button variant="ghost" size="sm" disabled={remove.pending} onClick={onCancel}>
              Anuluj
            </Button>
          </div>
        </>
      )}
      {remove.error && <p className="text-destructive text-sm whitespace-pre-wrap">{remove.error}</p>}
    </div>
  );
}
