import {
  agentsApi,
  countLabel,
  proposalRepos,
  type RunningMiseTask,
  type Session,
  type SessionList,
  type Task,
  type TaskMessage,
  type TaskOutcome,
} from "@trackwall/protocol";
import { BellRing, Crown, Lightbulb, Plus, Square, X } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { CopilotUsageMark } from "@/components/CopilotUsageMark";
import { CopyRequestNotice } from "@/components/CopyRequestNotice";
import { EnvironmentChangeNotice } from "@/components/EnvironmentChangeNotice";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { ModelChangeButton, SessionModelChange } from "@/components/ModelChange";
import { ReadRequestNotice } from "@/components/ReadRequestNotice";
import { SessionScreen } from "@/components/SessionScreen";
import { StatusLabel } from "@/components/StatusLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { listedUsage } from "@/lib/copilot-usage";
import type { LiveFeed } from "@/lib/daemon-events";
import { relativeTime, twoDigits } from "@/lib/format";
import { IS_MAC } from "@/lib/platform";
import {
  entryId,
  entryName,
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
import { type GridTile, gridPage, SESSION_LAYOUTS, type SessionLayout } from "@/lib/session-grid";
import { groupTiles, type RowGroup, sessionGroups, type TileGroup } from "@/lib/session-groups";
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
import { SessionJavaNavigationMark } from "./JavaNavigationMark.tsx";
import { NewSession } from "./NewSession.tsx";
import { ProposalInbox } from "./ProposalInbox.tsx";
import { RoutineList } from "./RoutineList.tsx";
import { EndTaskButton, SessionCloseButton, SessionCloseConfirmation, TaskEnding } from "./SessionClose.tsx";
import { SessionEnvironment } from "./SessionEnvironment.tsx";
import { SessionGrid } from "./SessionGrid.tsx";
import { GroupFilterChip, GroupLevel, GroupStripe, ShowGroupButton } from "./SessionGroupMarks.tsx";
import { TaskLine } from "./TaskLine.tsx";
import { TaskOutcomeMarks } from "./TaskOutcomeMarks.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { WorktreeCleanup } from "./WorktreeCleanup.tsx";

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
}) {
  const list = sessions.data?.sessions ?? [];
  const { tasks, rows } = tree;
  const entries = rows.map((r) => r.entry);
  const current = findEntry(entries, selected);
  const next = nextWaitingTarget(entries, current, supervisor.sessionWaits);
  const waiting = attentionCount(sessions.data);
  const groups = sessionGroups(rows.map((r) => ({ id: entryId(r.entry), depth: r.depth, supervised: r.supervised })));
  const groupOf = (entry: SessionEntry | undefined) => (entry ? groups[entries.indexOf(entry)]?.id : undefined);
  // The grid shows one group alone until you clear it, pick layout 1 or select an entry outside the group.
  const [shownGroup, setShownGroup] = useState<string | null>(null);
  const select = (selection: SessionSelection) => {
    if (shownGroup !== null && groupOf(findEntry(entries, selection)) !== shownGroup) setShownGroup(null);
    onSelect(selection);
  };
  const changeLayout = (next: SessionLayout) => {
    if (next === "1") setShownGroup(null);
    onLayout(next);
  };
  const showGroup = (row: number) => {
    const group = groups[row];
    if (!group) return;
    setShownGroup(group.id);
    const entry = rows[row]?.entry;
    if (entry && groupOf(current) !== group.id) onSelect(entrySelection(entry));
    onLayout("auto");
  };
  // A selection from outside the view (the tray, a link) can land outside the group, and then the grid shows everything.
  const filter = shownGroup !== null && groupOf(current) === shownGroup ? shownGroup : null;
  const filterTop = filter === null ? -1 : groups.findIndex((g) => g?.id === filter);
  const filterTopEntry = rows[filterTop]?.entry;
  const filterGroup = groups[filterTop];
  const groupChip = filterTopEntry && filterGroup && (
    <GroupFilterChip
      colour={filterGroup.colour}
      name={entryName(filterTopEntry)}
      size={groups.filter((g) => g?.id === filter).length}
      onClear={() => setShownGroup(null)}
    />
  );
  const tileGroups = new Map<string, TileGroup>(
    rows.flatMap((row, i): [string, TileGroup][] => {
      const group = groups[i];
      if (!group) return [];
      const parent = group.parent === undefined ? undefined : rows[group.parent]?.entry;
      return [[entryId(row.entry), { colour: group.colour, under: parent && entryName(parent) }]];
    }),
  );
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
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">
            Sessions {sessions.data && <span className="text-primary">{`// ${twoDigits(entries.length)}`}</span>}
          </h2>
          <Button variant="ghost" size="icon" onClick={() => select({ kind: "new" })} aria-label="New task or Copilot CLI session">
            <Plus />
          </Button>
        </div>
        <ListedUsage sessions={list} />
        {next && (
          <div className="px-4 pb-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => (next.kind === "supervisor" ? onShowSupervisor() : select(entrySelection(next)))}
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
              onSelect={() => select(entrySelection(row.entry))}
              group={groups[i] ?? null}
              onShowGroup={() => showGroup(i)}
              onSessionClosed={() => sessionClosed(row.entry)}
              onTaskRemoved={taskRemoved}
              outcomes={outcomes}
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
          <div className="min-h-0 overflow-y-auto">
            <NewSession
              conn={conn}
              sessions={sessions.data.sessions}
              onStarted={started}
              onCancel={entries.length > 0 ? () => select(undefined) : undefined}
            />
            <RoutineList conn={conn} onStarted={started} />
            <WorktreeCleanup conn={conn} onRemoved={sessions.reload} />
          </div>
        )}
        {current && (
          <SelectedEntry
            conn={conn}
            entries={entries}
            tiles={groupTiles(entries, groups, filter)}
            groupChip={groupChip}
            tileGroups={tileGroups}
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
  group,
  onShowGroup,
  onSessionClosed,
  onTaskRemoved,
  outcomes,
}: {
  conn: Connection;
  row: SessionRow;
  position: number;
  active: boolean;
  onSelect: () => void;
  /** The row's group of related sessions, `null` for a row alone. */
  group: RowGroup | null;
  onShowGroup: () => void;
  onSessionClosed: () => void;
  onTaskRemoved: (task: string) => void;
  outcomes: ReadonlyMap<string, TaskOutcome>;
}) {
  const { entry, depth } = row;
  return (
    <div className="group/row relative">
      {group && <GroupStripe colour={group.colour} className="top-1 bottom-1 left-0 w-1" />}
      <div className={cn(INDENT[Math.min(depth, INDENT.length - 1)], depth > 0 && "border-l pl-1")}>
        {entry.kind === "proposals" ? (
          <ProposalsListItem entry={entry} position={position} active={active} onSelect={onSelect} group={group} />
        ) : (
          <StartedListItem
            conn={conn}
            entry={entry}
            group={group}
            delegated={row.children}
            position={position}
            active={active}
            onSelect={onSelect}
            onSessionClosed={onSessionClosed}
            onTaskRemoved={onTaskRemoved}
            outcome={entry.kind === "task" ? outcomes.get(entry.task.id) : undefined}
          />
        )}
      </div>
      {group && (
        <ShowGroupButton
          onClick={onShowGroup}
          className={cn(
            "absolute right-1.5 bottom-1.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
            active && "opacity-100",
          )}
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
  group,
  delegated,
  position,
  active,
  onSelect,
  onSessionClosed,
  onTaskRemoved,
  outcome,
}: {
  conn: Connection;
  entry: StartedEntry;
  group: RowGroup | null;
  /** Tasks and proposals directly under this entry. */
  delegated: number;
  position: number;
  active: boolean;
  onSelect: () => void;
  onSessionClosed: () => void;
  onTaskRemoved: (task: string) => void;
  outcome: TaskOutcome | undefined;
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
          <RowName name={entryName(entry)} group={group} delegated={delegated} waits={session?.needsAttention === true} />
          {task && <TaskLine task={task} />}
          <RowStatus session={session} />
          <TaskOutcomeMarks outcome={outcome} />
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
function RowName({
  name,
  group,
  delegated,
  waits,
}: {
  name: string;
  /** The row's group, for its level under the group's main session; the supervisor heading has none. */
  group?: RowGroup | null;
  delegated: number;
  waits: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm font-medium">{name}</span>
      {group && <GroupLevel colour={group.colour} level={group.level} />}
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
  group,
}: {
  entry: ProposalsEntry;
  position: number;
  active: boolean;
  onSelect: () => void;
  group: RowGroup | null;
}) {
  const repos = [...new Set(entry.proposals.flatMap(proposalRepos))].join(", ");
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
          {group && <GroupLevel colour={group.colour} level={group.level} />}
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
  tiles,
  groupChip,
  tileGroups,
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
  /** Each grouped entry's colour and what it sits under, by entry id, for its tile. */
  tileGroups: ReadonlyMap<string, TileGroup>;
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
        groups={tileGroups}
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

const NEXT_WAITING = { kind: "next-waiting" } as const;

/** The "Next waiting" button: the count of the list, which leaves the supervisor out, so it is named once only it waits. */
function nextWaitingLabel(next: WaitingTarget, waiting: number): string {
  if (next.kind === "supervisor") return "The supervisor is waiting for you";
  return waiting === 1 ? "One thing is waiting for you" : `Next waiting (${waiting})`;
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

/** A row's session state and what its conversation used (ADR-190). */
function RowStatus({ session }: { session: Session | undefined }) {
  if (session === undefined) return <span className="text-muted-foreground text-xs">no session</span>;
  return (
    <span className="text-muted-foreground flex items-center gap-3 text-xs">
      <StatusLabel {...sessionStateLabel(session)} />
      <CopilotUsageMark usage={session.usage} />
    </span>
  );
}

/** What the listed sessions used together (ADR-190), under the list's heading; nothing before any of them called a model. */
function ListedUsage({ sessions }: { sessions: readonly Session[] }) {
  const usage = listedUsage(sessions);
  if (usage === null) return null;
  return (
    <div className="px-4 pb-2">
      <CopilotUsageMark usage={usage} prefix="Listed sessions:" />
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
              <StatusLabel {...sessionStateLabel(session)} />
            </span>
            <span className="text-muted-foreground text-xs">{relativeTime(session.startedAt, new Date())}</span>
            <CopilotUsageMark usage={session.usage} />
          </span>
          {session.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
        </div>
        {error && <span className="text-destructive max-w-xs truncate text-xs">{error}</span>}
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
      <EnvironmentChangeNotice key={session.id} conn={conn} session={session} onRestarted={onChanged} />
      <ReadRequestNotice key={`read-request-${session.id}`} conn={conn} session={session} onDelivered={onChanged} />
      <CopyRequestNotice key={session.id} conn={conn} session={session} onCleared={onChanged} />
      <SessionScreen conn={conn} session={session} selected />
    </>
  );
}
