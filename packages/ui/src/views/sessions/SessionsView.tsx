import {
  agentsApi,
  countLabel,
  type RunningMiseTask,
  type Session,
  type SessionList,
  type Task,
  type TaskMessage,
} from "@trackwall/protocol";
import { BellRing, Crown, Lightbulb, Plus, Square, X } from "lucide-react";
import { useCallback, useRef } from "react";
import { EnvironmentChangeNotice } from "@/components/EnvironmentChangeNotice";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { SessionScreen } from "@/components/SessionScreen";
import { StatusLabel } from "@/components/StatusLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { relativeTime, twoDigits } from "@/lib/format";
import { IS_MAC } from "@/lib/platform";
import {
  entryId,
  entrySelection,
  findEntry,
  nextWaitingTarget,
  type ProposalsEntry,
  proposalKindLabel,
  proposalsName,
  type SessionEntry,
  type SessionRow,
  type SessionSelection,
  type StartedEntry,
  selectedProposal,
  selectedTaskTab,
  selectionAfterClose,
  selectionAfterRemoval,
  type TaskTab,
  type WaitingTarget,
} from "@/lib/session-entries";
import { gridPage, SESSION_LAYOUTS, type SessionLayout } from "@/lib/session-grid";
import {
  ariaSessionShortcut,
  SHORTCUT_POSITIONS,
  SUPERVISOR_SHORTCUT,
  sessionShortcut,
  sessionShortcutLabel,
} from "@/lib/session-shortcut";
import { attentionCount, isLive, PROPOSAL_STATUS, SUPERVISOR, sessionPlace, sessionStateLabel } from "@/lib/session-state";
import type { SupervisorSummary } from "@/lib/supervisor";
import { useAction } from "@/lib/use-action";
import type { RemoteHandle } from "@/lib/use-remote";
import { useSessionClose } from "@/lib/use-session-close";
import type { SessionTree } from "@/lib/use-session-tree";
import { useTaskEnding } from "@/lib/use-task-ending";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import { cn } from "@/lib/utils";
import { NewSession } from "./NewSession.tsx";
import { ProposalInbox } from "./ProposalInbox.tsx";
import { EndTaskButton, SessionCloseButton, SessionCloseConfirmation, TaskEnding } from "./SessionClose.tsx";
import { SessionEnvironment } from "./SessionEnvironment.tsx";
import { SessionGrid } from "./SessionGrid.tsx";
import { TaskLine } from "./TaskLine.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

/**
 * The Sessions view (§4.4, ADR-26, ADR-31): several Copilot CLI sessions at once, each in a repo from the projects
 * folder or in a task's worktree. On the left the list of sessions and tasks with their state and a jump to the next
 * entry waiting for you, and above them the task proposals from agents (ADR-39), one entry per session that proposed
 * them (ADR-55); on the right the selected session's terminal, for a task also its changes, and for proposals their
 * prompts to decide on. `App` polls the list, since the count of waiting sessions and proposals is on the view bar too.
 *
 * Since ADR-48 the right side shows the selected entry alone or a page of the list as a grid of terminals, and
 * Alt + digit selects an entry by its position; `App` keeps the layout across views and owns Alt+J.
 */
export function SessionsView({
  conn,
  sessions,
  runningLive,
  selected,
  onSelect,
  layout,
  onLayout,
  onShowSupervisor,
  onShowImpact,
  tree,
  supervisor,
}: {
  conn: Connection;
  sessions: RemoteHandle<SessionList>;
  /** Pushes of the running mise tasks, for the mise tasks a task's agent runs in its worktree. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  selected: SessionSelection;
  onSelect: (selection: SessionSelection) => void;
  layout: SessionLayout;
  onLayout: (layout: SessionLayout) => void;
  /** Opens the supervisor panel (ADR-58): the supervisor heading of the list leads there, not to a terminal here. */
  onShowSupervisor: () => void;
  /** Opens the Overview graph with a task's impact lit (ADR-147). */
  onShowImpact: (task: string) => void;
  /** The list rows and their tasks, without a task the user has just ended (`useSessionTree`). */
  tree: SessionTree;
  supervisor: SupervisorSummary;
}) {
  const list = sessions.data?.sessions ?? [];
  const { tasks, rows } = tree;
  const entries = rows.map((r) => r.entry);
  const current = findEntry(entries, selected);
  const next = nextWaitingTarget(entries, current, supervisor.sessionWaits);
  const waiting = attentionCount(sessions.data);
  // A stop can take seconds, and a decision on proposals a while, and the user may select another entry meanwhile, so
  // both decide on the selection as it is when they end. `entries` comes from the render of the click (the action keeps
  // that `onDone`), so it still holds the closed entry even when a refreshed list without it arrived before the close ended.
  const latestSelected = useRef(selected);
  latestSelected.current = selected;
  const currentSelection = useCallback(() => latestSelected.current, []);
  const sessionClosed = (entry: SessionEntry) => {
    const afterClose = selectionAfterClose(entries, latestSelected.current, entry);
    if (afterClose !== "keep") onSelect(afterClose);
    sessions.reload();
  };
  // The ended task vanishes at once instead of after the list refresh, so that no panel shows it again without its worktree.
  const taskRemoved = (task: string) => {
    const removed = entries.find((entry) => entry.kind === "task" && entry.task.id === task);
    const afterRemoval = removed ? selectionAfterRemoval(entries, latestSelected.current, removed) : "keep";
    tree.hideTask(task);
    if (afterRemoval !== "keep") onSelect(afterRemoval);
    sessions.reload();
  };
  // Taken also with no entry at that position, so that the key never reaches a session terminal by accident.
  useWindowShortcuts(
    (event) => {
      const shortcut = sessionShortcut(event, IS_MAC);
      return shortcut?.kind === "position" ? shortcut : undefined;
    },
    ({ position }) => {
      const entry = entries[position - 1];
      if (entry) onSelect(entrySelection(entry));
      return true;
    },
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr]">
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">
            Sessions {sessions.data && <span className="text-primary">{`// ${twoDigits(entries.length)}`}</span>}
          </h2>
          <Button variant="ghost" size="icon" onClick={() => onSelect({ kind: "new" })} aria-label="New task or Copilot CLI session">
            <Plus />
          </Button>
        </div>
        {next && (
          <div className="px-4 pb-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => (next.kind === "supervisor" ? onShowSupervisor() : onSelect(entrySelection(next)))}
              aria-keyshortcuts={ariaSessionShortcut(NEXT_WAITING)}
            >
              <BellRing /> {nextWaitingLabel(next, waiting)}
              <span className="text-muted-foreground ml-auto font-mono text-2xs">{sessionShortcutLabel(NEXT_WAITING, IS_MAC)}</span>
            </Button>
          </div>
        )}
        <nav aria-label="Session list" className="flex-1 overflow-y-auto px-2 pb-4">
          {sessions.error && <ErrorWithRetry message={sessions.error} onRetry={sessions.reload} />}
          {sessions.data && entries.length === 0 && (
            <p className="text-muted-foreground px-2 text-sm">
              No sessions yet. Give the agent a task or start Copilot CLI in a repo from your projects folder.
            </p>
          )}
          {supervisor.listed && <SupervisorListItem supervisor={supervisor} onOpen={onShowSupervisor} />}
          {rows.map((row, i) => (
            <SessionListItem
              key={entryId(row.entry)}
              conn={conn}
              row={row}
              position={i + 1}
              active={current !== undefined && entryId(row.entry) === entryId(current)}
              onSelect={() => onSelect(entrySelection(row.entry))}
              onSessionClosed={() => sessionClosed(row.entry)}
              onTaskRemoved={taskRemoved}
            />
          ))}
        </nav>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col">
        {!sessions.data && !sessions.error && (
          <div className="flex h-full items-center justify-center p-6">
            <Loading />
          </div>
        )}
        {sessions.data && !current && (
          <NewSession
            conn={conn}
            sessions={sessions.data.sessions}
            onStarted={(selection) => {
              onSelect(selection);
              sessions.reload();
            }}
            onCancel={entries.length > 0 ? () => onSelect(undefined) : undefined}
          />
        )}
        {current && (
          <SelectedEntry
            conn={conn}
            entries={entries}
            current={current}
            focus={selectedProposal(selected)}
            taskTab={selectedTaskTab(selected)}
            currentSelection={currentSelection}
            layout={layout}
            onLayout={onLayout}
            onSelect={onSelect}
            sessions={list}
            tasks={tasks}
            messages={sessions.data?.messages ?? []}
            runningLive={runningLive}
            onChanged={sessions.reload}
            onSessionClosed={sessionClosed}
            onTaskRemoved={taskRemoved}
            onShowImpact={onShowImpact}
          />
        )}
      </section>
    </div>
  );
}

/** Indent per tree level; deeper rows do not move further, so the repo name still fits in the panel. */
const INDENT = ["", "ml-4", "ml-8", "ml-12"] as const;

/**
 * A list row: an entry indented under the session that proposed it, with a line along the children of one main session.
 * A session or task that delegated work has a “main” badge with the number of entries under it.
 */
function SessionListItem({
  conn,
  row,
  position,
  active,
  onSelect,
  onSessionClosed,
  onTaskRemoved,
}: {
  conn: Connection;
  row: SessionRow;
  position: number;
  active: boolean;
  onSelect: () => void;
  onSessionClosed: () => void;
  onTaskRemoved: (task: string) => void;
}) {
  const { entry, depth } = row;
  return (
    <div className={cn(INDENT[Math.min(depth, INDENT.length - 1)], depth > 0 && "border-l pl-1")}>
      {entry.kind === "proposals" ? (
        <ProposalsListItem entry={entry} position={position} active={active} onSelect={onSelect} />
      ) : (
        <StartedListItem
          conn={conn}
          entry={entry}
          delegated={row.children}
          position={position}
          active={active}
          onSelect={onSelect}
          onSessionClosed={onSessionClosed}
          onTaskRemoved={onTaskRemoved}
        />
      )}
    </div>
  );
}

/**
 * A session or task row. Its X closes the session, or ends a task without a session; it shows on hover, on keyboard
 * focus and on the selected row.
 */
function StartedListItem({
  conn,
  entry,
  delegated,
  position,
  active,
  onSelect,
  onSessionClosed,
  onTaskRemoved,
}: {
  conn: Connection;
  entry: StartedEntry;
  /** Tasks and proposals directly under this entry. */
  delegated: number;
  position: number;
  active: boolean;
  onSelect: () => void;
  onSessionClosed: () => void;
  onTaskRemoved: (task: string) => void;
}) {
  const { session } = entry;
  const task = entry.kind === "task" ? entry.task : undefined;
  const close = useSessionClose(conn, session, onSessionClosed);
  const sessionlessTask = task && !session ? task : undefined;
  const ending = useTaskEnding(sessionlessTask !== undefined);
  const xClass = cn(
    "absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
    (active || close.confirming || ending.open) && "opacity-100",
  );
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active || undefined}
        aria-keyshortcuts={ariaSessionShortcut({ kind: "position", position })}
        className={cn(ROW_BUTTON, active && "bg-accent border-primary/25 hud-active-edge")}
      >
        <PositionLabel position={position} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <RowName name={task?.repo ?? (session && sessionPlace(session))} delegated={delegated} waits={session?.needsAttention === true} />
          {task && <TaskLine task={task} />}
          <span className="text-muted-foreground text-xs">{session ? <StatusLabel {...sessionStateLabel(session)} /> : "no session"}</span>
          {session?.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
        </span>
      </button>
      {session && <SessionCloseButton close={close} className={xClass} />}
      {sessionlessTask && <EndTaskButton onClick={ending.show} className={xClass} />}
      <SessionCloseConfirmation close={close} />
      {sessionlessTask && ending.open && (
        <TaskEnding conn={conn} task={sessionlessTask} onRemoved={() => onTaskRemoved(sessionlessTask.id)} onCancel={ending.hide} />
      )}
    </div>
  );
}

/**
 * The supervisor heading (ADR-58) above the list, with the work it delegated right under it. It has no position: Alt+0
 * reaches it, and it opens the supervisor panel instead of a terminal in this view.
 */
function SupervisorListItem({ supervisor, onOpen }: { supervisor: SupervisorSummary; onOpen: () => void }) {
  const { session } = supervisor;
  return (
    <button type="button" onClick={onOpen} aria-keyshortcuts={ariaSessionShortcut(SUPERVISOR_SHORTCUT)} className={ROW_BUTTON}>
      <span className="flex w-8 shrink-0 flex-col items-end gap-0.5 pt-0.5">
        <Crown className="text-primary size-3.5" aria-hidden />
        <span className="text-muted-foreground/70 font-mono text-2xs">{sessionShortcutLabel(SUPERVISOR_SHORTCUT, IS_MAC)}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <RowName name={SUPERVISOR} delegated={supervisor.delegated} waits={supervisor.sessionWaits} />
        <span className="text-muted-foreground text-xs">{session ? <StatusLabel {...sessionStateLabel(session)} /> : "not running"}</span>
      </span>
    </button>
  );
}

const ROW_BUTTON =
  "flex w-full items-start gap-3 rounded-md border border-transparent py-2 pr-8 pl-2 text-left transition-colors hover:bg-accent";

/**
 * The first line of a session, task or supervisor row: its name, the "main" badge with the work delegated under it
 * (the supervisor is the main session above all repos) and a bell while it waits for you.
 */
function RowName({ name, delegated, waits }: { name: string | null | undefined; delegated: number; waits: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm font-medium">{name}</span>
      {delegated > 0 && (
        <Badge aria-label={`main session, ${countLabel(delegated, { one: "task or proposal", other: "tasks and proposals" })} under it`}>
          {`main · ${delegated}`}
        </Badge>
      )}
      {waits && <BellRing className="text-warning size-3.5 shrink-0" aria-label="waiting for you" />}
    </span>
  );
}

/** The position of a list entry and its Alt + digit shortcut, the same for sessions, tasks and proposals. */
function PositionLabel({ position }: { position: number }) {
  const shortcut = sessionShortcutLabel({ kind: "position", position }, IS_MAC);
  return (
    <span className="flex w-8 shrink-0 flex-col items-end gap-0.5 pt-0.5 font-mono">
      <span className="text-muted-foreground text-2xs">{twoDigits(position)}</span>
      {shortcut && <span className="text-muted-foreground/70 text-2xs">{shortcut}</span>}
    </span>
  );
}

/**
 * The task proposals of one session on the list (ADR-55): they wait for your decision, so they have the warning tone
 * of a waiting session; the repos tell what the plan touches.
 */
function ProposalsListItem({
  entry,
  position,
  active,
  onSelect,
}: {
  entry: ProposalsEntry;
  position: number;
  active: boolean;
  onSelect: () => void;
}) {
  const repos = [...new Set(entry.proposals.map((p) => p.repo))].join(", ");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      aria-keyshortcuts={ariaSessionShortcut({ kind: "position", position })}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent border-primary/25 hud-active-edge",
      )}
    >
      <PositionLabel position={position} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <Lightbulb className="text-warning size-3.5 shrink-0" aria-hidden />
          <span className="truncate text-sm font-medium">
            {entry.proposals.length === 1 ? proposalKindLabel(entry.proposals[0]) : proposalsName(entry.proposals)}
          </span>
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {entry.proposals.length === 1 ? proposalsName(entry.proposals) : repos}
        </span>
        <span className="text-xs">
          <StatusLabel {...PROPOSAL_STATUS} />
        </span>
      </span>
    </button>
  );
}

/** The right side for a selected entry: the layout switch, then the entry with its full panel or a grid page with it. */
function SelectedEntry({
  conn,
  entries,
  current,
  focus,
  taskTab,
  currentSelection,
  layout,
  onLayout,
  onSelect,
  sessions,
  tasks,
  messages,
  runningLive,
  onChanged,
  onSessionClosed,
  onTaskRemoved,
  onShowImpact,
}: {
  conn: Connection;
  entries: readonly SessionEntry[];
  current: SessionEntry;
  /** The selected task proposal, to open first among the proposals of its session. */
  focus: string | undefined;
  /** The tab the selected task's panel opens on. */
  taskTab: TaskTab | undefined;
  currentSelection: () => SessionSelection;
  layout: SessionLayout;
  onLayout: (layout: SessionLayout) => void;
  onSelect: (selection: SessionSelection) => void;
  sessions: readonly Session[];
  /** The tasks on the list, for the task panel's shared-files warning. */
  tasks: readonly Task[];
  /** The messages proposers sent the tasks' sessions (ADR-68), for the task panel. */
  messages: readonly TaskMessage[];
  /** Pushes of the running mise tasks, for the mise tasks a task's agent runs in its worktree. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  onChanged: () => void;
  onSessionClosed: (entry: SessionEntry) => void;
  onTaskRemoved: (task: string) => void;
  onShowImpact: (task: string) => void;
}) {
  if (layout === "1")
    return (
      <>
        <LayoutBar layout={layout} onLayout={onLayout} />
        <EntryPanel
          conn={conn}
          entry={current}
          focus={focus}
          taskTab={taskTab}
          currentSelection={currentSelection}
          sessions={sessions}
          tasks={tasks}
          messages={messages}
          runningLive={runningLive}
          onSelect={onSelect}
          onChanged={onChanged}
          onSessionClosed={onSessionClosed}
          onTaskRemoved={onTaskRemoved}
          onShowImpact={onShowImpact}
        />
      </>
    );
  const selected = entryId(current);
  const page = gridPage(
    layout,
    entries,
    entries.findIndex((e) => entryId(e) === selected),
  );
  return (
    <>
      <LayoutBar
        layout={layout}
        onLayout={onLayout}
        summary={`${entries.length} in the list${page.pages > 1 ? ` · page ${page.page + 1} of ${page.pages}` : ""}`}
      />
      <SessionGrid
        conn={conn}
        page={page}
        selected={selected}
        onSelect={(entry) => onSelect(entrySelection(entry))}
        onOpenAlone={(entry) => {
          onSelect(entrySelection(entry));
          onLayout("1");
        }}
        onOpenChanges={(task) => {
          onSelect({ kind: "task", id: task, tab: "changes" });
          onLayout("1");
        }}
        tasks={tasks}
        onChanged={onChanged}
        onNavigate={onSelect}
        currentSelection={currentSelection}
        onSessionClosed={onSessionClosed}
        onTaskRemoved={onTaskRemoved}
        sessions={sessions}
        messages={messages}
        runningLive={runningLive}
      />
    </>
  );
}

/** The full panel of one entry: task proposals to decide on, a task with its tabs, or a session in a repo root. */
function EntryPanel({
  conn,
  entry,
  focus,
  taskTab,
  currentSelection,
  sessions,
  tasks,
  messages,
  runningLive,
  onSelect,
  onChanged,
  onSessionClosed,
  onTaskRemoved,
  onShowImpact,
}: {
  conn: Connection;
  entry: SessionEntry;
  focus: string | undefined;
  taskTab: TaskTab | undefined;
  currentSelection: () => SessionSelection;
  sessions: readonly Session[];
  /** The tasks on the list, for the task panel's shared-files warning and the same-repo hint of proposals. */
  tasks: readonly Task[];
  /** The messages proposers sent the tasks' sessions (ADR-68), for the task panel. */
  messages: readonly TaskMessage[];
  /** Pushes of the running mise tasks, for the mise tasks a task's agent runs in its worktree. */
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  onSelect: (selection: SessionSelection) => void;
  onChanged: () => void;
  onSessionClosed: (entry: SessionEntry) => void;
  onTaskRemoved: (task: string) => void;
  onShowImpact: (task: string) => void;
}) {
  if (entry.kind === "proposals")
    return (
      <ProposalInbox
        key={entryId(entry)}
        conn={conn}
        group={entry}
        focus={focus}
        sessions={sessions}
        tasks={tasks}
        onChanged={onChanged}
        onSelect={onSelect}
        currentSelection={currentSelection}
      />
    );
  if (entry.kind === "task")
    return (
      <TaskPanel
        key={entry.task.id}
        conn={conn}
        task={entry.task}
        session={entry.session}
        sessions={sessions}
        tasks={tasks}
        messages={messages.filter((m) => m.task === entry.task.id)}
        runningLive={runningLive}
        onChanged={onChanged}
        onRemoved={() => onTaskRemoved(entry.task.id)}
        onOpenTask={(id) => onSelect({ kind: "task", id })}
        onShowImpact={onShowImpact}
        initialTab={taskTab}
      />
    );
  return (
    <SessionPanel
      key={entry.session.id}
      conn={conn}
      session={entry.session}
      onChanged={onChanged}
      onClosed={() => onSessionClosed(entry)}
    />
  );
}

const NEXT_WAITING = { kind: "next-waiting" } as const;

/** The "Next waiting" button: the count of the list, which leaves the supervisor out, so it is named once only it waits. */
function nextWaitingLabel(next: WaitingTarget, waiting: number): string {
  if (next.kind === "supervisor") return "The supervisor is waiting for you";
  return waiting === 1 ? "One thing is waiting for you" : `Next waiting (${waiting})`;
}

const LAYOUT_LABELS: Record<SessionLayout, string> = { "1": "1", "2": "2", "4": "4", auto: "Auto" };

/** The layout switch above the right side: one entry with its full panel, or a grid of 2, 4 or all entries. */
function LayoutBar({ layout, onLayout, summary }: { layout: SessionLayout; onLayout: (layout: SessionLayout) => void; summary?: string }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-1.5">
      <span className="hud-label shrink-0">Layout</span>
      <fieldset aria-label="Layout" className="flex shrink-0 overflow-hidden rounded-md border">
        {SESSION_LAYOUTS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === layout}
            onClick={() => onLayout(option)}
            className={cn(
              "px-3 py-0.5 font-mono text-xs transition-colors",
              option === layout ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {LAYOUT_LABELS[option]}
          </button>
        ))}
      </fieldset>
      {summary && <span className="text-muted-foreground text-xs">{summary}</span>}
      <span className="text-muted-foreground ml-auto min-w-0 truncate font-mono text-2xs">
        {`${sessionShortcutLabel({ kind: "position", position: 1 }, IS_MAC)}…${SHORTCUT_POSITIONS} select · ${sessionShortcutLabel(NEXT_WAITING, IS_MAC)} next waiting`}
      </span>
    </div>
  );
}

/** The header of the selected session (repo, state, what it works on, buttons) and its terminal. Close of an ended session is the X's close (`useSessionClose`). */
function SessionPanel({
  conn,
  session,
  onChanged,
  onClosed,
}: {
  conn: Connection;
  session: Session;
  onChanged: () => void;
  onClosed: () => void;
}) {
  const live = isLive(session);
  const stop = useAction(() => post(conn, agentsApi.stop, { session: session.id }), onChanged);
  const close = useSessionClose(conn, session, onClosed);
  const error = live ? stop.error : close.error;
  return (
    <>
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm font-medium">{sessionPlace(session)}</span>
            <span className="text-muted-foreground text-xs">
              <StatusLabel {...sessionStateLabel(session)} />
            </span>
            <span className="text-muted-foreground text-xs">{relativeTime(session.startedAt, new Date())}</span>
          </span>
          {session.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
        </div>
        {error && <span className="text-destructive max-w-xs truncate text-xs">{error}</span>}
        {live ? (
          <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending || session.run.kind === "stopping"}>
            <Square /> Stop
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={close.request} disabled={close.pending}>
            <X /> Close
          </Button>
        )}
      </header>
      <SessionEnvironment environment={session.environment} />
      <EnvironmentChangeNotice key={session.id} conn={conn} session={session} onRestarted={onChanged} />
      <SessionScreen conn={conn} session={session} selected />
    </>
  );
}
