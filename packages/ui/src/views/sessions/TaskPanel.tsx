import { agentsApi, type RunningMiseTask, type Session, TASK_PORT_ENV, type Task, type TaskMessage } from "@trackwall/protocol";
import { Code, GitBranch, Play, Plug, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { SessionTerminal } from "@/components/SessionTerminal";
import { StatusLabel } from "@/components/StatusLabel";
import { TabBar } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { relativeTime } from "@/lib/format";
import { proposerLabel, taskName } from "@/lib/session-entries";
import { isLive, sessionStateLabel } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { useTaskMergeRequest } from "@/lib/use-task-merge-request";
import { useTaskReview } from "@/lib/use-task-review";
import { useTaskVerification } from "@/lib/use-task-verification";
import { SharedFiles } from "./SharedFiles.tsx";
import { TaskChangesView } from "./TaskChangesView.tsx";
import { TaskIncludedFiles } from "./TaskIncludedFiles.tsx";
import { TaskMergeRequest } from "./TaskMergeRequest.tsx";
import { TaskMessages } from "./TaskMessages.tsx";
import { TaskMiseConfig } from "./TaskMiseConfig.tsx";
import { TaskMiseRuns } from "./TaskMiseRuns.tsx";
import { TaskRemoval } from "./TaskRemoval.tsx";
import { TaskSummary } from "./TaskSummary.tsx";
import { TaskVerification, VerifyButton } from "./TaskVerification.tsx";

type TaskTab = "terminal" | "changes";

/**
 * The selected task (ADR-31): title or prompt, branch and session state in the header, the session terminal and the
 * worktree changes in tabs. A task from a proposal says who proposed it, and the summary from the task session (ADR-39)
 * sits above the tabs. A task without a running session can be resumed or ended; the worktree always opens in VS Code.
 * The warnings about files another task also changes (ADR-44) and about a changed mise config of the worktree (ADR-59)
 * sit above the summary, and the mise tasks the agent runs in the worktree below it. The header shows the task port, and
 * the files copied from the repo root into the worktree come first (ADR-61). The review comments written in the
 * "Changes" tab live here, so that switching tabs keeps them (ADR-62). The Verify button in the header runs the
 * task's tests, and the verdict sits below the summary (ADR-64), followed by the task's way to a merge request: its push,
 * the repo host's form and the merge request with its pipeline (ADR-77). The messages the task's proposer sent its
 * session sit above the summary (ADR-68).
 */
export function TaskPanel({
  conn,
  task,
  session,
  sessions,
  tasks,
  messages,
  runningLive,
  onChanged,
  onRemoved,
  onOpenTask,
}: {
  conn: Connection;
  task: Task;
  session: Session | undefined;
  /** All sessions from the list, to name the session that proposed the task. */
  sessions: readonly Session[];
  /** All tasks on the list, to name the task that changes the same files. */
  tasks: readonly Task[];
  /** The messages the task's proposer sent its session (ADR-68), oldest first. */
  messages: readonly TaskMessage[];
  /** Pushes of the running mise tasks, for the mise tasks a task's agent runs in its worktree. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  onChanged: () => void;
  onRemoved: () => void;
  onOpenTask: (id: string) => void;
}) {
  const liveSession = session && isLive(session) ? session : undefined;
  const [tab, setTab] = useState<TaskTab>("terminal");
  const [removing, setRemoving] = useState(false);
  const review = useTaskReview(conn, task.id);
  const confirmingRemoval = removing && !liveSession;
  const verification = useTaskVerification(conn, task.id, confirmingRemoval);
  const mergeRequest = useTaskMergeRequest(conn, task.id, confirmingRemoval);
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
      {/* In a narrow column (the supervisor panel pinned on a small screen) the buttons wrap under the task. */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
        <div className="flex min-w-60 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            {/* The branch, longer and repeating the task, gives way first. */}
            <span className="max-w-1/2 shrink-0 truncate text-sm font-medium">{task.repo}</span>
            <span className="text-muted-foreground flex min-w-0 items-center gap-1 font-mono text-xs">
              <GitBranch className="size-3 shrink-0" aria-label="branch" />
              <span className="truncate">{task.branch}</span>
            </span>
            <span
              className="text-muted-foreground flex shrink-0 items-center gap-1 font-mono text-xs"
              title={`task port: ${TASK_PORT_ENV.join(" and ")} of its mise tasks`}
            >
              <Plug className="size-3" aria-label="task port" />
              {task.port}
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <VerifyButton state={verification} disabled={confirmingRemoval} />
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
        </div>
      </header>
      {confirmingRemoval && <TaskRemoval conn={conn} task={task} onRemoved={onRemoved} onCancel={() => setRemoving(false)} />}
      {/* At most a third of the panel, scrolling beyond it: on a small screen the sections would leave the terminal a few
          lines, and Copilot CLI cuts a dialog taller than its terminal. */}
      <section aria-label="Task details" className="max-h-1/3 shrink-0 overflow-y-auto">
        <TaskIncludedFiles included={task.included} />
        <SharedFiles conn={conn} task={task.id} tasks={tasks} paused={confirmingRemoval} onOpenTask={onOpenTask} />
        <TaskMiseConfig conn={conn} task={task.id} paused={confirmingRemoval} />
        <TaskMessages messages={messages} sessions={sessions} />
        {task.summary && <TaskSummary summary={task.summary} />}
        <TaskVerification conn={conn} state={verification} />
        <TaskMergeRequest conn={conn} task={task} verification={verification.verification} state={mergeRequest} />
        <TaskMiseRuns
          conn={conn}
          task={task.id}
          live={runningLive}
          paused={confirmingRemoval}
          shownElsewhere={verification.runningMiseTask}
        />
      </section>
      <div className="px-4">
        <TabBar tabs={tabs} active={shown} onSelect={setTab} />
      </div>
      {shown === "terminal" && session && (
        <SessionTerminal key={session.id} conn={conn} session={session.id} live={liveSession !== undefined} selected />
      )}
      {shown === "changes" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskChangesView conn={conn} task={task.id} paused={confirmingRemoval} review={review} />
        </div>
      )}
    </>
  );
}

/** The task's title or prompt and, for a task from a proposal, who proposed it. */
function taskSubtitle(task: Task, sessions: readonly Session[]): string {
  const name = taskName(task);
  return task.proposedBy ? `${name} · ${proposerLabel(task.proposedBy, sessions)}` : name;
}

/** Stopping the task's running session; the error shows next to the button. */
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
