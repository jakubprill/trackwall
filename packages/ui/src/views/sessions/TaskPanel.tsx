import {
  mayHandToSupervisor,
  type RunningMiseTask,
  type Session,
  TASK_PORT_ENV,
  type Task,
  type TaskMessage,
  type TaskOutcome,
} from "@trackwall/protocol";
import { Bot, Box, GitBranch, Layers, Plug, ShieldOff, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { CopyRequestNotice } from "@/components/CopyRequestNotice";
import { EnvironmentChangeNotice } from "@/components/EnvironmentChangeNotice";
import { FolderShell } from "@/components/FolderShell";
import { ReadRequestNotice } from "@/components/ReadRequestNotice";
import { SessionScreen } from "@/components/SessionScreen";
import { StatusLabel } from "@/components/StatusLabel";
import { TabBar } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { relativeTime } from "@/lib/format";
import { proposerLabel, type TaskTab, taskName, taskTabs } from "@/lib/session-entries";
import { isLive, sessionStateLabel } from "@/lib/session-state";
import { useTaskDetails } from "@/lib/use-task-details";
import { useTaskReview } from "@/lib/use-task-review";
import { JavaNavigationMark } from "./JavaNavigationMark.tsx";
import { SessionEnvironment } from "./SessionEnvironment.tsx";
import { CopyIncludedFilesButton, HandToSupervisorButton, ResumeButton, StopButton, TaskEditorButton } from "./TaskButtons.tsx";
import { TaskChangesView } from "./TaskChangesView.tsx";
import { scrollToSection, TaskDetails } from "./TaskDetails.tsx";
import { TaskImpact } from "./TaskImpact.tsx";
import { TaskMcpCalls } from "./TaskMcpCalls.tsx";
import { TaskNoticeStrip } from "./TaskNotices.tsx";
import { TaskRemoval } from "./TaskRemoval.tsx";
import { TaskRounds } from "./TaskRounds.tsx";
import { VerifyButton } from "./TaskVerification.tsx";

/**
 * The selected task (ADR-31): title or prompt, branch, task port, its model when it has one (ADR-98), a mark when it runs without approvals (ADR-105), how its Java language server is doing (ADR-124) and session state in the header, the session terminal (or its conversation, for a task in the conversation view, ADR-137)
 * and the worktree changes in tabs, its rounds with "Undo round" in a third (ADR-168), and the repos its change reaches in a fourth (ADR-147). A task from a proposal says who proposed it. A task without a running session can
 * be resumed or ended; the worktree always opens in VS Code, and the Verify button runs the task's tests (ADR-64).
 * What the task has to say above its session (`TaskDetails`: warnings, messages, summary, verification, merge
 * request, mise tasks) is folded into one strip of notices that "Details" unfolds (ADR-91), so the session keeps the
 * panel's height. The review comments written in the "Changes" tab live here, so that switching tabs keeps them (ADR-62).
 */
export function TaskPanel({
  conn,
  task,
  session,
  sessions,
  tasks,
  outcomes,
  messages,
  runningLive,
  onChanged,
  onRemoved,
  onOpenTask,
  onShowImpact,
  initialTab = "session",
}: {
  conn: Connection;
  task: Task;
  session: Session | undefined;
  /** All sessions from the list, to name the session that proposed the task. */
  sessions: readonly Session[];
  /** All tasks on the list, to name the task that changes the same files. */
  tasks: readonly Task[];
  /** The outcomes of the tasks, for the merge requests of a change's parts (ADR-172). */
  outcomes: ReadonlyMap<string, TaskOutcome>;
  /** The messages the task's proposer sent its session (ADR-68), oldest first. */
  messages: readonly TaskMessage[];
  /** Pushes of the running mise tasks, for the mise tasks a task's agent runs in its worktree. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  onChanged: () => void;
  onRemoved: () => void;
  onOpenTask: (id: string) => void;
  /** Opens the Overview graph with the task's impact lit (ADR-147). */
  onShowImpact: (task: string) => void;
  /** The tab the panel opens on, "Changes" when a grid tile asked for them. */
  initialTab?: TaskTab;
}) {
  const liveSession = session && isLive(session) ? session : undefined;
  const [tab, setTab] = useState<TaskTab>(initialTab);
  const [removing, setRemoving] = useState(false);
  const review = useTaskReview(conn, task.id);
  const confirmingRemoval = removing && !liveSession;
  const details = useTaskDetails({ conn, task, tasks, outcomes, messages, runningLive, paused: confirmingRemoval });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsArea = useRef<HTMLElement>(null);
  const shown: TaskTab = session || tab !== "session" ? tab : "changes";
  const tabs = taskTabs(session);

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
            <JavaNavigationMark conn={conn} task={task} running={liveSession !== undefined} />
            <span className="text-muted-foreground shrink-0 text-xs">
              {session ? <StatusLabel {...sessionStateLabel(session)} /> : "no session"}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">{relativeTime(session?.startedAt ?? task.createdAt, new Date())}</span>
          </span>
          <span className="text-muted-foreground truncate text-xs" title={task.prompt}>
            {taskSubtitle(task, sessions)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <VerifyButton state={details.verification} disabled={confirmingRemoval} />
          <TaskEditorButton conn={conn} task={task} label="VS Code" />
          <CopyIncludedFilesButton conn={conn} task={task} onCopied={onChanged} />
          {mayHandToSupervisor(task) && (
            <HandToSupervisorButton conn={conn} task={task} disabled={confirmingRemoval} onHanded={onChanged} />
          )}
          {liveSession ? (
            <StopButton conn={conn} session={liveSession} onStopped={onChanged} />
          ) : (
            <>
              <ResumeButton
                conn={conn}
                task={task}
                disabled={removing}
                onResumed={() => {
                  setTab("session");
                  onChanged();
                }}
              />
              <Button variant="outline" size="sm" onClick={() => setRemoving(true)} disabled={removing}>
                <Trash2 /> End task
              </Button>
            </>
          )}
        </div>
      </header>
      <SessionEnvironment environment={session?.environment} />
      <EnvironmentChangeNotice key={session?.id} conn={conn} session={session} onRestarted={onChanged} />
      <ReadRequestNotice key={`read-request-${session?.id}`} conn={conn} session={session} onDelivered={onChanged} />
      {session && <CopyRequestNotice key={session.id} conn={conn} session={session} onCleared={onChanged} />}
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
      <TaskTabContent
        shown={shown}
        conn={conn}
        task={task}
        session={session}
        paused={confirmingRemoval}
        review={review}
        onOpenTask={onOpenTask}
        onShowImpact={onShowImpact}
      />
    </>
  );
}

/** The content of the open tab. */
function TaskTabContent({
  shown,
  conn,
  task,
  session,
  paused,
  review,
  onOpenTask,
  onShowImpact,
}: {
  shown: TaskTab;
  conn: Connection;
  task: Task;
  session: Session | undefined;
  paused: boolean;
  review: ReturnType<typeof useTaskReview>;
  onOpenTask: (id: string) => void;
  onShowImpact: (task: string) => void;
}) {
  return (
    <>
      {shown === "session" && session && <SessionScreen conn={conn} session={session} selected review={review} />}
      {shown === "shell" && <FolderShell key={task.id} conn={conn} place={{ repo: task.repo, task: task.id }} folder={task.worktree} />}
      {shown === "changes" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskChangesView conn={conn} task={task.id} paused={paused} review={review} />
        </div>
      )}
      {shown === "rounds" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskRounds conn={conn} task={task.id} paused={paused} />
        </div>
      )}
      {shown === "impact" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskImpact conn={conn} task={task} paused={paused} onOpenTask={onOpenTask} onShowOnOverview={onShowImpact} />
        </div>
      )}
      {shown === "mcp-calls" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskMcpCalls conn={conn} task={task.id} />
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

/**
 * What the task runs with beyond the defaults: its model (ADR-98), running without approvals (ADR-105), its commands in
 * Copilot CLI's sandbox (ADR-181), and its place
 * in a change (ADR-171), whose parts the Sessions list shows in their merge order.
 */
function TaskMarks({ task }: { task: Task }) {
  return (
    <>
      {task.change !== null && (
        <span
          className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs"
          title="A part of a change across several repos: the Sessions list shows its parts in the order to merge them"
        >
          <Layers className="size-3" aria-hidden />
          Part of a change
        </span>
      )}
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
      {task.sandbox && (
        <span
          className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs"
          title="Its commands run in Copilot CLI's sandbox: they write only in the worktree and cannot see your other repos or credential folders"
        >
          <Box className="size-3" aria-hidden />
          Sandbox
        </span>
      )}
    </>
  );
}
