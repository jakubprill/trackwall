import { agentsApi, type RunningMiseTask, type Session, TASK_PORT_ENV, type Task, type TaskMessage } from "@trackwall/protocol";
import { Bot, Code, GitBranch, Play, Plug, ShieldOff, Square, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { EnvironmentChangeNotice } from "@/components/EnvironmentChangeNotice";
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
import { useTaskDetails } from "@/lib/use-task-details";
import { useTaskReview } from "@/lib/use-task-review";
import { SessionEnvironment } from "./SessionEnvironment.tsx";
import { TaskChangesView } from "./TaskChangesView.tsx";
import { scrollToSection, TaskDetails } from "./TaskDetails.tsx";
import { TaskNoticeStrip } from "./TaskNotices.tsx";
import { TaskRemoval } from "./TaskRemoval.tsx";
import { VerifyButton } from "./TaskVerification.tsx";

type TaskTab = "terminal" | "changes";

/**
 * The selected task (ADR-31): title or prompt, branch, task port, its model when it has one (ADR-98), a mark when it runs without approvals (ADR-105) and session state in the header, the session terminal
 * and the worktree changes in tabs. A task from a proposal says who proposed it. A task without a running session can
 * be resumed or ended; the worktree always opens in VS Code, and the Verify button runs the task's tests (ADR-64).
 * What the task has to say above its terminal (`TaskDetails`: warnings, messages, summary, verification, merge
 * request, mise tasks) is folded into one strip of notices that "Details" unfolds (ADR-91), so the terminal keeps the
 * panel's height. The review comments written in the "Changes" tab live here, so that switching tabs keeps them (ADR-62).
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
  const details = useTaskDetails({ conn, task, tasks, messages, runningLive, paused: confirmingRemoval });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsArea = useRef<HTMLElement>(null);
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
            <TaskMarks task={task} />
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
          <VerifyButton state={details.verification} disabled={confirmingRemoval} />
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
      <SessionEnvironment environment={session?.environment} />
      <EnvironmentChangeNotice conn={conn} session={session} onRestarted={onChanged} />
      {confirmingRemoval && <TaskRemoval conn={conn} task={task} onRemoved={onRemoved} onCancel={() => setRemoving(false)} />}
      <TaskNoticeStrip
        notices={details.notices}
        open={detailsOpen}
        onToggle={() => setDetailsOpen(!detailsOpen)}
        onOpen={(section) => {
          setDetailsOpen(true);
          scrollToSection(detailsArea.current, section);
        }}
      />
      {/* At most a third of the panel, scrolling beyond it: on a small screen the sections would leave the terminal a few
          lines, and Copilot CLI cuts a dialog taller than its terminal. */}
      {/* Hidden rather than unmounted when folded, so that a section keeps what the user did in it (the mise config shown
          for trust, an open log). */}
      <section ref={detailsArea} hidden={!detailsOpen} aria-label="Task details" className="max-h-1/3 shrink-0 overflow-y-auto">
        <TaskDetails conn={conn} task={task} details={details} sessions={sessions} onOpenTask={onOpenTask} />
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

/** What the task runs with beyond the defaults: its model (ADR-98) and running without approvals (ADR-105). */
function TaskMarks({ task }: { task: Task }) {
  return (
    <>
      {task.model !== null && (
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 font-mono text-xs" title="Copilot CLI model">
          <Bot className="size-3" aria-label="model" />
          {task.model}
        </span>
      )}
      {task.approvals === "auto" && (
        <span
          className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs"
          title="Copilot CLI runs every tool without asking; deny rules still apply"
        >
          <ShieldOff className="size-3" aria-hidden />
          No approvals
        </span>
      )}
    </>
  );
}
