import {
  agentsApi,
  type RunningMiseTask,
  type Session,
  type SessionList,
  type Task,
  type TaskMessage,
  type TaskOutcome,
  type WorkspaceSettings,
} from "@trackwall/protocol";
import { Square, X } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { CopilotUsageMark } from "@/components/CopilotUsageMark";
import { Loading } from "@/components/Loading";
import { ModelChangeButton, SessionModelChange } from "@/components/ModelChange";
import { SessionNotices } from "@/components/SessionNotices";
import { SessionScreen } from "@/components/SessionScreen";
import { SessionStateLabel } from "@/components/SessionStateLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { relativeTime } from "@/lib/format";
import { IS_MAC } from "@/lib/platform";
import {
  entryId,
  entrySelection,
  findEntry,
  type SessionEntry,
  type SessionSelection,
  selectedProposal,
  selectedTaskTab,
  selectionAfterClose,
  selectionAfterRemoval,
  type TaskTab,
} from "@/lib/session-entries";
import { type GridTile, gridPage, SESSION_LAYOUTS, type SessionLayout } from "@/lib/session-grid";
import { activeGroup, type EntryGroup, groupTiles, listGroups } from "@/lib/session-groups";
import { SHORTCUT_POSITIONS, sessionShortcut, sessionShortcutLabel } from "@/lib/session-shortcut";
import { isLive, sessionPlace } from "@/lib/session-state";
import type { SupervisorSummary } from "@/lib/supervisor";
import { useAction } from "@/lib/use-action";
import type { RemoteHandle } from "@/lib/use-remote";
import { useSessionClose } from "@/lib/use-session-close";
import type { SessionTree } from "@/lib/use-session-tree";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import { cn } from "@/lib/utils";
import { SessionJavaNavigationMark } from "./JavaNavigationMark.tsx";
import { NewSessionPane } from "./NewSessionPane.tsx";
import { ProposalInbox } from "./ProposalInbox.tsx";
import { SessionEditorButton } from "./SessionEditorButton.tsx";
import { SessionEnvironment } from "./SessionEnvironment.tsx";
import { SessionGrid } from "./SessionGrid.tsx";
import { GroupFilterChip } from "./SessionGroupMarks.tsx";
import { NEXT_WAITING, SessionListPanel } from "./SessionListPanel.tsx";
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
  outcomes,
  workspace,
  onRetry,
  onOpenGetStarted,
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
  /** What each task's work came to, by task (ADR-154), for the marks on its row. */
  outcomes: ReadonlyMap<string, TaskOutcome>;
  /** The window's read of the workspace settings (`useWorkspaceSettings`): the form waits for the projects folder, which the card above it sets. */
  workspace: RemoteHandle<WorkspaceSettings>;
  /** Reconnects to the daemon, for a read that failed because the daemon is gone. */
  onRetry: () => void;
  /** Opens Settings › Get started, with every step and what is good to have. */
  onOpenGetStarted: () => void;
}) {
  const list = sessions.data?.sessions ?? [];
  const { tasks, rows } = tree;
  const entries = rows.map((r) => r.entry);
  const current = findEntry(entries, selected);
  const groups = listGroups(rows);
  const groupOf = (entry: SessionEntry | undefined) => (entry ? groups.get(entryId(entry))?.id : undefined);
  // The grid shows one group alone until you clear it, pick layout 1 or select an entry outside the group.
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  const shownGroup = activeGroup(pickedGroup, groups, current);
  const select = (selection: SessionSelection) => {
    if (pickedGroup !== null && groupOf(findEntry(entries, selection)) !== pickedGroup) setPickedGroup(null);
    onSelect(selection);
  };
  const changeLayout = (next: SessionLayout) => {
    if (next === "1") setPickedGroup(null);
    onLayout(next);
  };
  const showGroup = (entry: SessionEntry) => {
    const group = groupOf(entry);
    if (group === undefined) return;
    setPickedGroup(group);
    if (groupOf(current) !== group) onSelect(entrySelection(entry));
    onLayout("auto");
  };
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
  const started = (selection: SessionSelection) => {
    select(selection);
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
      if (entry) select(entrySelection(entry));
      return true;
    },
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--spacing-sidebar)_1fr]">
      <SessionListPanel
        conn={conn}
        sessions={sessions}
        rows={rows}
        groups={groups}
        current={current}
        supervisor={supervisor}
        outcomes={outcomes}
        onSelect={select}
        onShowSupervisor={onShowSupervisor}
        onShowGroup={showGroup}
        onSessionClosed={sessionClosed}
        onTaskRemoved={taskRemoved}
      />
      <section className="flex min-h-0 min-w-0 flex-col">
        {!sessions.data && !sessions.error && (
          <div className="flex h-full items-center justify-center p-6">
            <Loading />
          </div>
        )}
        {sessions.data && !current && (
          <NewSessionPane
            conn={conn}
            sessions={sessions.data.sessions}
            workspace={workspace}
            onStarted={started}
            onCancel={entries.length > 0 ? () => select(undefined) : undefined}
            onWorktreesRemoved={sessions.reload}
            onRetry={onRetry}
            onOpenGetStarted={onOpenGetStarted}
          />
        )}
        {current && (
          <SelectedEntry
            conn={conn}
            entries={entries}
            tiles={groupTiles(entries, groups, shownGroup)}
            groupChip={shownGroup && <GroupFilterChip group={shownGroup} onClear={() => setPickedGroup(null)} />}
            groups={groups}
            current={current}
            focus={selectedProposal(selected)}
            taskTab={selectedTaskTab(selected)}
            currentSelection={currentSelection}
            layout={layout}
            onLayout={changeLayout}
            onSelect={select}
            sessions={list}
            tasks={tasks}
            outcomes={outcomes}
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

/** The right side for a selected entry: the layout switch, then the entry with its full panel or a grid page with it. */
function SelectedEntry({
  conn,
  entries,
  tiles,
  groupChip,
  groups,
  current,
  focus,
  taskTab,
  currentSelection,
  layout,
  onLayout,
  onSelect,
  sessions,
  tasks,
  outcomes,
  messages,
  runningLive,
  onChanged,
  onSessionClosed,
  onTaskRemoved,
  onShowImpact,
}: {
  conn: Connection;
  entries: readonly SessionEntry[];
  /** The grid's tiles: the whole list, or one group of it (`groupTiles`). */
  tiles: readonly GridTile<SessionEntry>[];
  /** The chip of the filter to one group on the layout bar, while it is on. */
  groupChip: ReactNode;
  /** Each grouped entry's group, by entry id, for its tile. */
  groups: ReadonlyMap<string, EntryGroup>;
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
  /** The outcomes of the tasks, for the merge requests of a change's parts (ADR-172). */
  outcomes: ReadonlyMap<string, TaskOutcome>;
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
          outcomes={outcomes}
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
    tiles,
    tiles.findIndex((t) => entryId(t.entry) === selected),
  );
  const shown = tiles.length === entries.length ? `${entries.length} in the list` : `${tiles.length} of ${entries.length} in the list`;
  return (
    <>
      <LayoutBar
        layout={layout}
        onLayout={onLayout}
        filter={groupChip}
        summary={`${shown}${page.pages > 1 ? ` · page ${page.page + 1} of ${page.pages}` : ""}`}
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
        outcomes={outcomes}
        messages={messages}
        runningLive={runningLive}
        groups={groups}
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
  outcomes,
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
  /** The outcomes of the tasks, for the merge requests of a change's parts (ADR-172). */
  outcomes: ReadonlyMap<string, TaskOutcome>;
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
        outcomes={outcomes}
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

const LAYOUT_LABELS: Record<SessionLayout, string> = { "1": "1", "2": "2", "4": "4", auto: "Auto" };

/** The layout switch above the right side: one entry with its full panel, or a grid of 2, 4 or all entries. */
function LayoutBar({
  layout,
  onLayout,
  filter,
  summary,
}: {
  layout: SessionLayout;
  onLayout: (layout: SessionLayout) => void;
  filter?: ReactNode;
  summary?: string;
}) {
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
      {filter}
      {summary && <span className="text-muted-foreground shrink-0 text-xs">{summary}</span>}
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
  const [changingModel, setChangingModel] = useState(false);
  const error = live ? stop.error : close.error;
  return (
    <>
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm font-medium">{sessionPlace(session)}</span>
            <SessionJavaNavigationMark conn={conn} session={session} running={live} />
            <span className="text-muted-foreground text-xs">
              <SessionStateLabel session={session} />
            </span>
            <span className="text-muted-foreground text-xs">{relativeTime(session.startedAt, new Date())}</span>
            <CopilotUsageMark usage={session.usage} />
          </span>
          {session.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
        </div>
        {error && <span className="text-destructive max-w-xs truncate text-xs">{error}</span>}
        <SessionEditorButton conn={conn} session={session} />
        {live && (
          <ModelChangeButton
            open={changingModel}
            onToggle={() => setChangingModel(!changingModel)}
            title="Restart the session on another model"
          />
        )}
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
      {live && changingModel && (
        <SessionModelChange
          key={session.id}
          conn={conn}
          session={session}
          onDone={() => {
            setChangingModel(false);
            onChanged();
          }}
          onCancel={() => setChangingModel(false)}
        />
      )}
      <SessionNotices conn={conn} session={session} onChanged={onChanged} />
      <SessionScreen conn={conn} session={session} selected />
    </>
  );
}
