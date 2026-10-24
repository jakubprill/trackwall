import { agentsApi, type Session, type Task } from "@trackwall/protocol";
import { Code, GitBranch, Play, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { isLive, sessionStateLabel } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { SessionTerminal } from "./SessionTerminal.tsx";
import { TabBar } from "./TabBar.tsx";
import { TaskChangesView } from "./TaskChangesView.tsx";
import { TaskRemoval } from "./TaskRemoval.tsx";

type TaskTab = "terminal" | "changes";

/**
 * Wybrane zadanie (ADR-31): polecenie, gałąź i stan sesji w nagłówku, terminal sesji i zmiany w worktree w zakładkach.
 * Zadanie bez działającej sesji można wznowić albo zakończyć; worktree otwiera się w VS Code zawsze.
 */
export function TaskPanel({
  conn,
  task,
  session,
  onChanged,
  onRemoved,
}: {
  conn: Connection;
  task: Task;
  session: Session | undefined;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const live = session !== undefined && isLive(session);
  const [tab, setTab] = useState<TaskTab>("terminal");
  const [removing, setRemoving] = useState(false);
  const resume = useAction(
    () => post(conn, agentsApi.resumeTask, { task: task.id }),
    () => {
      setTab("terminal");
      onChanged();
    },
  );
  const openEditor = useAction(
    () => post(conn, agentsApi.openTaskEditor, { task: task.id }),
    () => {},
  );
  const error = resume.error ?? openEditor.error;
  const shown: TaskTab = session ? tab : "changes";
  const tabs = session
    ? ([
        { id: "terminal", label: "Terminal" },
        { id: "changes", label: "Zmiany" },
      ] as const)
    : ([{ id: "changes", label: "Zmiany" }] as const);

  return (
    <>
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm font-medium">{task.repo}</span>
            <span className="text-muted-foreground flex min-w-0 items-center gap-1 font-mono text-xs">
              <GitBranch className="size-3 shrink-0" aria-label="gałąź" />
              <span className="truncate">{task.branch}</span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {session ? <StatusLabel {...sessionStateLabel(session)} /> : "bez sesji"}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">{relativeTime(session?.startedAt ?? task.createdAt, new Date())}</span>
          </span>
          <span className="text-muted-foreground truncate text-xs" title={task.prompt}>
            {task.prompt}
          </span>
        </div>
        {error && <span className="text-destructive max-w-xs truncate text-xs">{error}</span>}
        <Button variant="outline" size="sm" onClick={openEditor.run} disabled={openEditor.pending}>
          <Code /> VS Code
        </Button>
        {session && live ? (
          <StopButton conn={conn} session={session} onStopped={onChanged} />
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={resume.run} disabled={resume.pending || removing}>
              <Play /> Wznów
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRemoving(true)} disabled={removing}>
              <Trash2 /> Zakończ zadanie
            </Button>
          </>
        )}
      </header>
      {removing && !live && <TaskRemoval conn={conn} task={task} onRemoved={onRemoved} onCancel={() => setRemoving(false)} />}
      <div className="px-4">
        <TabBar tabs={tabs} active={shown} onSelect={setTab} />
      </div>
      {shown === "terminal" && session && <SessionTerminal key={session.id} conn={conn} session={session.id} live={live} />}
      {shown === "changes" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskChangesView conn={conn} task={task.id} paused={removing} />
        </div>
      )}
    </>
  );
}

/** Zatrzymanie działającej sesji zadania; błąd obok przycisku. */
function StopButton({ conn, session, onStopped }: { conn: Connection; session: Session; onStopped: () => void }) {
  const stop = useAction(() => post(conn, agentsApi.stop, { session: session.id }), onStopped);
  return (
    <>
      {stop.error && <span className="text-destructive max-w-xs truncate text-xs">{stop.error}</span>}
      <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending || session.run.kind === "stopping"}>
        <Square /> Zatrzymaj
      </Button>
    </>
  );
}
