import { agentsApi, type Session, type Task } from "@trackwall/protocol";
import { Code, GitBranch, Play, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { TabBar } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { proposerLabel, taskName } from "@/lib/session-entries";
import { isLive, sessionStateLabel } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { SessionTerminal } from "./SessionTerminal.tsx";
import { SharedFiles } from "./SharedFiles.tsx";
import { TaskChangesView } from "./TaskChangesView.tsx";
import { TaskRemoval } from "./TaskRemoval.tsx";

type TaskTab = "terminal" | "changes";

/**
 * Wybrane zadanie (ADR-31): tytuł albo polecenie, gałąź i stan sesji w nagłówku, terminal sesji i zmiany w worktree
 * w zakładkach. Zadanie z propozycji mówi, kto je zaproponował, a podsumowanie od sesji zadania (ADR-39) stoi nad
 * zakładkami. Zadanie bez działającej sesji można wznowić albo zakończyć; worktree otwiera się w VS Code zawsze.
 * The warning about files another task also changes (ADR-44) sits above the summary.
 */
export function TaskPanel({
  conn,
  task,
  session,
  sessions,
  tasks,
  onChanged,
  onRemoved,
  onOpenTask,
}: {
  conn: Connection;
  task: Task;
  session: Session | undefined;
  /** Wszystkie sesje z listy, żeby nazwać sesję, która zaproponowała zadanie. */
  sessions: readonly Session[];
  /** All tasks on the list, to name the task that changes the same files. */
  tasks: readonly Task[];
  onChanged: () => void;
  onRemoved: () => void;
  onOpenTask: (id: string) => void;
}) {
  const liveSession = session && isLive(session) ? session : undefined;
  const [tab, setTab] = useState<TaskTab>("terminal");
  const [removing, setRemoving] = useState(false);
  const confirmingRemoval = removing && !liveSession;
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
        { id: "changes", label: "Changes" },
      ] as const)
    : ([{ id: "changes", label: "Changes" }] as const);

  return (
    <>
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm font-medium">{task.repo}</span>
            <span className="text-muted-foreground flex min-w-0 items-center gap-1 font-mono text-xs">
              <GitBranch className="size-3 shrink-0" aria-label="branch" />
              <span className="truncate">{task.branch}</span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {session ? <StatusLabel {...sessionStateLabel(session)} /> : "no session"}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">{relativeTime(session?.startedAt ?? task.createdAt, new Date())}</span>
          </span>
          <span className="text-muted-foreground truncate text-xs" title={task.prompt}>
            {taskSubtitle(task, sessions)}
          </span>
        </div>
        {error && <span className="text-destructive max-w-xs truncate text-xs">{error}</span>}
        <Button variant="outline" size="sm" onClick={openEditor.run} disabled={openEditor.pending}>
          <Code /> VS Code
        </Button>
        {liveSession ? (
          <StopButton conn={conn} session={liveSession} onStopped={onChanged} />
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={resume.run} disabled={resume.pending || removing}>
              <Play /> Resume
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRemoving(true)} disabled={removing}>
              <Trash2 /> End task
            </Button>
          </>
        )}
      </header>
      {confirmingRemoval && <TaskRemoval conn={conn} task={task} onRemoved={onRemoved} onCancel={() => setRemoving(false)} />}
      <SharedFiles conn={conn} task={task.id} tasks={tasks} paused={confirmingRemoval} onOpenTask={onOpenTask} />
      {task.summary && <TaskSummary summary={task.summary} />}
      <div className="px-4">
        <TabBar tabs={tabs} active={shown} onSelect={setTab} />
      </div>
      {shown === "terminal" && session && (
        <SessionTerminal key={session.id} conn={conn} session={session.id} live={liveSession !== undefined} focused />
      )}
      {shown === "changes" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskChangesView conn={conn} task={task.id} paused={confirmingRemoval} />
        </div>
      )}
    </>
  );
}

/** Tytuł albo polecenie zadania, a przy zadaniu z propozycji także to, kto je zaproponował. */
function taskSubtitle(task: Task, sessions: readonly Session[]): string {
  const name = taskName(task);
  return task.proposedBy ? `${name} · ${proposerLabel(task.proposedBy, sessions)}` : name;
}

/** Podsumowanie od sesji zadania (`report_result`) z czasem zgłoszenia. */
function TaskSummary({ summary }: { summary: NonNullable<Task["summary"]> }) {
  return (
    <section aria-label="Summary from the task session" className="flex flex-col gap-1 border-b px-4 py-3">
      <span className="hud-label">
        Summary <span className="text-muted-foreground font-sans normal-case">{relativeTime(summary.reportedAt, new Date())}</span>
      </span>
      {/* Najwyżej kilka linii: dłuższe podsumowanie przewija się, a nie ściska terminala sesji pod spodem. */}
      <p className="max-h-32 max-w-prose overflow-auto text-sm whitespace-pre-wrap">{summary.text}</p>
    </section>
  );
}

/** Zatrzymanie działającej sesji zadania; błąd obok przycisku. */
function StopButton({ conn, session, onStopped }: { conn: Connection; session: Session; onStopped: () => void }) {
  const stop = useAction(() => post(conn, agentsApi.stop, { session: session.id }), onStopped);
  return (
    <>
      {stop.error && <span className="text-destructive max-w-xs truncate text-xs">{stop.error}</span>}
      <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending || session.run.kind === "stopping"}>
        <Square /> Stop
      </Button>
    </>
  );
}
