import { countLabel, proposalRepos, type Session, type SessionList, type Task, type TaskOutcome } from "@trackwall/protocol";
import { BellRing, Crown, Lightbulb, Plus } from "lucide-react";
import { CopilotUsageMark } from "@/components/CopilotUsageMark";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { SessionStateLabel } from "@/components/SessionStateLabel";
import { StatusLabel } from "@/components/StatusLabel";
import { TaskOutcomeMarks } from "@/components/TaskOutcomeMarks";
import { TaskStateLabel } from "@/components/TaskStateLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { listedUsage } from "@/lib/copilot-usage";
import { twoDigits } from "@/lib/format";
import { IS_MAC } from "@/lib/platform";
import {
  entryId,
  entryName,
  entrySelection,
  nextWaitingTarget,
  type ProposalsEntry,
  proposalKindLabel,
  proposalsName,
  type SessionEntry,
  type SessionRow,
  type SessionSelection,
  type StartedEntry,
  type WaitingTarget,
} from "@/lib/session-entries";
import type { EntryGroup } from "@/lib/session-groups";
import { ariaSessionShortcut, SUPERVISOR_SHORTCUT, sessionShortcutLabel } from "@/lib/session-shortcut";
import { attentionCount, PROPOSAL_STATUS, SUPERVISOR } from "@/lib/session-state";
import type { SupervisorSummary } from "@/lib/supervisor";
import { outcomeMarks } from "@/lib/task-outcomes";
import type { Remote } from "@/lib/use-remote";
import { useSessionClose } from "@/lib/use-session-close";
import { useTaskEnding } from "@/lib/use-task-ending";
import { cn } from "@/lib/utils";
import { EndTaskButton, SessionCloseButton, SessionCloseConfirmation, TaskEnding } from "./SessionClose.tsx";
import { GroupLevel, GroupStripe, ShowGroupButton } from "./SessionGroupMarks.tsx";
import { TaskLine } from "./TaskLine.tsx";

/**
 * The list on the left of the Sessions view (§4.4): the sessions, tasks and task proposals with their state, the jump
 * to the next entry waiting for you, and the supervisor heading above them. It takes everything it shows as props, so
 * that the gallery of view states (`src/gallery`) shows it in every state with the same code as the view.
 */
export function SessionListPanel({
  conn,
  sessions,
  rows,
  groups,
  current,
  supervisor,
  outcomes,
  onSelect,
  onShowSupervisor,
  onShowGroup,
  onSessionClosed,
  onTaskRemoved,
}: {
  conn: Connection;
  sessions: Remote<SessionList> & { reload: () => void };
  /** The list rows, without a task the user has just ended (`useSessionTree`). */
  rows: readonly SessionRow[];
  /** Each grouped entry's group, by entry id (`listGroups`). */
  groups: ReadonlyMap<string, EntryGroup>;
  /** The selected entry, `undefined` for none. */
  current: SessionEntry | undefined;
  supervisor: SupervisorSummary;
  /** What each task's work came to, by task (ADR-154), for the marks on its row. */
  outcomes: ReadonlyMap<string, TaskOutcome>;
  onSelect: (selection: SessionSelection) => void;
  /** Opens the supervisor panel (ADR-58): the supervisor heading of the list leads there, not to a terminal. */
  onShowSupervisor: () => void;
  onShowGroup: (entry: SessionEntry) => void;
  onSessionClosed: (entry: SessionEntry) => void;
  onTaskRemoved: (task: string) => void;
}) {
  const list = sessions.data?.sessions ?? [];
  const entries = rows.map((r) => r.entry);
  const next = nextWaitingTarget(entries, current, supervisor.sessionWaits);
  const waiting = attentionCount(sessions.data);
  return (
    <aside className="bg-card flex min-h-0 flex-col border-r">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="hud-label">Sessions {sessions.data && <span className="text-primary">{`// ${twoDigits(entries.length)}`}</span>}</h2>
        <Button variant="ghost" size="icon" onClick={() => onSelect({ kind: "new" })} aria-label="New task or Copilot CLI session">
          <Plus />
        </Button>
      </div>
      <ListedUsage sessions={list} />
      {next && (
        <div className="px-4 pb-3">
          <Button
            variant="outline"
            size="sm"
            // The label wraps instead of running past the frame: with a wider system font (Segoe UI on Windows) the
            // longest one and the shortcut do not fit the list's width on one line.
            className="h-auto min-h-8 w-full py-1.5 text-left whitespace-normal"
            onClick={() => (next.kind === "supervisor" ? onShowSupervisor() : onSelect(entrySelection(next)))}
            aria-keyshortcuts={ariaSessionShortcut(NEXT_WAITING)}
          >
            <BellRing /> <span className="min-w-0">{nextWaitingLabel(next, waiting)}</span>
            <span className="text-muted-foreground ml-auto shrink-0 font-mono text-2xs">{sessionShortcutLabel(NEXT_WAITING, IS_MAC)}</span>
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
            group={groups.get(entryId(row.entry)) ?? null}
            onShowGroup={() => onShowGroup(row.entry)}
            onSessionClosed={() => onSessionClosed(row.entry)}
            onTaskRemoved={onTaskRemoved}
            outcomes={outcomes}
          />
        ))}
      </nav>
    </aside>
  );
}

/** Indent per tree level; deeper rows do not move further, so the repo name still fits in the panel. */
const INDENT = ["", "ml-4", "ml-8", "ml-12"] as const;

/**
 * The room left of every row for its group's stripe, so that the stripe stays beside a selected row instead of under its
 * background and edge, also on a group's top row; the supervisor heading gets it too, to line up with the rows.
 */
const STRIPE_GUTTER = "pl-2";

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
  group: EntryGroup | null;
  onShowGroup: () => void;
  onSessionClosed: () => void;
  onTaskRemoved: (task: string) => void;
  outcomes: ReadonlyMap<string, TaskOutcome>;
}) {
  const { entry, depth } = row;
  return (
    <div className={cn("group/row relative", STRIPE_GUTTER)}>
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
        // On hover and keyboard focus only, like the X: over the end of the last line, which it would hide for good if it stayed.
        <ShowGroupButton
          onClick={onShowGroup}
          className="bg-card absolute right-1.5 bottom-1.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
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
  group: EntryGroup | null;
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
          <RowStatus task={task} session={session} />
          <TaskOutcomeMarks marks={outcomeMarks(outcome, task?.inReview === true)} />
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
    <div className={STRIPE_GUTTER}>
      <button type="button" onClick={onOpen} aria-keyshortcuts={ariaSessionShortcut(SUPERVISOR_SHORTCUT)} className={ROW_BUTTON}>
        <span className="flex w-10 shrink-0 flex-col items-end gap-0.5 pt-0.5">
          <Crown className="text-primary size-3.5" aria-hidden />
          <span className="text-muted-foreground/70 font-mono text-2xs">{sessionShortcutLabel(SUPERVISOR_SHORTCUT, IS_MAC)}</span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <RowName name={SUPERVISOR} group={null} delegated={supervisor.delegated} waits={supervisor.sessionWaits} />
          <span className="text-muted-foreground text-xs">{session ? <SessionStateLabel session={session} /> : "not running"}</span>
        </span>
      </button>
    </div>
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
  /** The row's group, for its level under the group's top entry; `null` for a row alone and the supervisor heading. */
  group: EntryGroup | null;
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
    // Wide enough for "Alt+1" with a wider font (Segoe UI), which ran left under a selected row's edge in 2rem.
    <span className="flex w-10 shrink-0 flex-col items-end gap-0.5 pt-0.5 font-mono">
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
  group: EntryGroup | null;
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

export const NEXT_WAITING = { kind: "next-waiting" } as const;

/** The "Next waiting" button: the count of the list, which leaves the supervisor out, so it is named once only it waits. */
function nextWaitingLabel(next: WaitingTarget, waiting: number): string {
  if (next.kind === "supervisor") return "The supervisor is waiting for you";
  return waiting === 1 ? "One thing is waiting for you" : `Next waiting (${waiting})`;
}

/**
 * A row's state (a task's, ADR-253, or its session's) and what its conversation used (ADR-190). The list is narrow, so
 * the usage goes under the state when the state with its waiting time takes the row.
 */
function RowStatus({ task, session }: { task: Task | undefined; session: Session | undefined }) {
  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
      {task ? <TaskStateLabel task={task} session={session} /> : session && <SessionStateLabel session={session} />}
      {session && <CopilotUsageMark usage={session.usage} />}
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
