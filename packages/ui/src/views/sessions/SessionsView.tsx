import { agentsApi, countLabel, type Session, type SessionList, TASK_PROMPT_MAX, type Task, workspaceApi } from "@trackwall/protocol";
import { BellRing, GitBranch, Lightbulb, Play, Plus, Square, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime, twoDigits } from "@/lib/format";
import { IS_MAC } from "@/lib/platform";
import {
  entryId,
  entrySelection,
  findEntry,
  nextWaiting,
  type ProposalsEntry,
  proposalsName,
  type SessionEntry,
  type SessionRow,
  type SessionSelection,
  type StartedEntry,
  selectedProposal,
  sessionRows,
} from "@/lib/session-entries";
import { gridPage, SESSION_LAYOUTS, type SessionLayout } from "@/lib/session-grid";
import { ariaSessionShortcut, SHORTCUT_POSITIONS, sessionShortcut, sessionShortcutLabel } from "@/lib/session-shortcut";
import { attentionCount, isLive, PROPOSAL_STATUS, sessionStateLabel } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { actionIsNewer, type RemoteHandle, useRemote } from "@/lib/use-remote";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import { cn } from "@/lib/utils";
import { ProposalInbox } from "./ProposalInbox.tsx";
import { SessionGrid } from "./SessionGrid.tsx";
import { SessionTerminal } from "./SessionTerminal.tsx";
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
  selected,
  onSelect,
  layout,
  onLayout,
}: {
  conn: Connection;
  sessions: RemoteHandle<SessionList>;
  selected: SessionSelection;
  onSelect: (selection: SessionSelection) => void;
  layout: SessionLayout;
  onLayout: (layout: SessionLayout) => void;
}) {
  const list = sessions.data?.sessions ?? [];
  // Zakończone zadanie znika od razu, a nie po odświeżeniu listy, żeby panel nie pokazał go znowu bez worktree.
  const [removed, setRemoved] = useState<{ task: string; afterLoad: number }>();
  const hidden = removed && actionIsNewer(removed.afterLoad, sessions.loadNumber) ? removed.task : undefined;
  const { tasks, rows } = visibleTasksAndRows(sessions.data, hidden);
  const entries = rows.map((r) => r.entry);
  const current = findEntry(entries, selected);
  const next = nextWaiting(entries, current);
  // A decision on proposals ends after a while; it reads the selection of that moment, not of the render that began it.
  const latestSelection = useRef(selected);
  latestSelection.current = selected;
  const currentSelection = useCallback(() => latestSelection.current, []);
  const waiting = attentionCount(sessions.data);
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
              onClick={() => onSelect(entrySelection(next))}
              aria-keyshortcuts={ariaSessionShortcut(NEXT_WAITING)}
            >
              <BellRing /> {waiting === 1 ? "One thing is waiting for you" : `Next waiting (${waiting})`}
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
          {rows.map((row, i) => (
            <SessionListItem
              key={entryId(row.entry)}
              row={row}
              position={i + 1}
              active={current !== undefined && entryId(row.entry) === entryId(current)}
              onSelect={() => onSelect(entrySelection(row.entry))}
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
            worktreesDir={sessions.data.worktreesDir}
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
            currentSelection={currentSelection}
            layout={layout}
            onLayout={onLayout}
            onSelect={onSelect}
            sessions={list}
            tasks={tasks}
            onChanged={sessions.reload}
            onTaskRemoved={(task) => {
              setRemoved({ task, afterLoad: sessions.sentLoads() });
              onSelect(undefined);
              sessions.reload();
            }}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Tasks and list rows without the task the user has just ended (`hidden`), which the list may still return; the same
 * tasks feed the tree and the task panel.
 */
function visibleTasksAndRows(data: SessionList | undefined, hidden: string | undefined): { tasks: Task[]; rows: SessionRow[] } {
  if (!data) return { tasks: [], rows: [] };
  const tasks = data.tasks.filter((t) => t.id !== hidden);
  return { tasks, rows: sessionRows({ ...data, tasks }) };
}

/** Indent per tree level; deeper rows do not move further, so the repo name still fits in the panel. */
const INDENT = ["", "ml-4", "ml-8", "ml-12"] as const;

/**
 * A list row: an entry indented under the session that proposed it, with a line along the children of one main session.
 * A session or task that delegated work has a “main” badge with the number of entries under it.
 */
function SessionListItem({
  row,
  position,
  active,
  onSelect,
}: {
  row: SessionRow;
  position: number;
  active: boolean;
  onSelect: () => void;
}) {
  const { entry, depth } = row;
  return (
    <div className={cn(INDENT[Math.min(depth, INDENT.length - 1)], depth > 0 && "border-l pl-1")}>
      {entry.kind === "proposals" ? (
        <ProposalsListItem entry={entry} position={position} active={active} onSelect={onSelect} />
      ) : (
        <StartedListItem entry={entry} delegated={row.children} position={position} active={active} onSelect={onSelect} />
      )}
    </div>
  );
}

function StartedListItem({
  entry,
  delegated,
  position,
  active,
  onSelect,
}: {
  entry: StartedEntry;
  /** Tasks and proposals directly under this entry. */
  delegated: number;
  position: number;
  active: boolean;
  onSelect: () => void;
}) {
  const { session } = entry;
  const task = entry.kind === "task" ? entry.task : undefined;
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
          <span className="truncate text-sm font-medium">{task?.repo ?? session?.repo}</span>
          {delegated > 0 && (
            <Badge
              aria-label={`main session, ${countLabel(delegated, { one: "task or proposal", other: "tasks and proposals" })} under it`}
            >{`main · ${delegated}`}</Badge>
          )}
          {session?.needsAttention && <BellRing className="text-warning size-3.5 shrink-0" aria-label="waiting for you" />}
        </span>
        {task && <TaskLine task={task} />}
        <span className="text-muted-foreground text-xs">{session ? <StatusLabel {...sessionStateLabel(session)} /> : "no session"}</span>
        {session?.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
      </span>
    </button>
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
            {entry.proposals.length === 1 ? "Task proposal" : proposalsName(entry.proposals)}
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
  currentSelection,
  layout,
  onLayout,
  onSelect,
  sessions,
  tasks,
  onChanged,
  onTaskRemoved,
}: {
  conn: Connection;
  entries: readonly SessionEntry[];
  current: SessionEntry;
  /** The selected task proposal, to open first among the proposals of its session. */
  focus: string | undefined;
  currentSelection: () => SessionSelection;
  layout: SessionLayout;
  onLayout: (layout: SessionLayout) => void;
  onSelect: (selection: SessionSelection) => void;
  sessions: readonly Session[];
  /** The tasks on the list, for the task panel's shared-files warning. */
  tasks: readonly Task[];
  onChanged: () => void;
  onTaskRemoved: (task: string) => void;
}) {
  if (layout === "1")
    return (
      <>
        <LayoutBar layout={layout} onLayout={onLayout} />
        <EntryPanel
          conn={conn}
          entry={current}
          focus={focus}
          currentSelection={currentSelection}
          sessions={sessions}
          tasks={tasks}
          onSelect={onSelect}
          onChanged={onChanged}
          onTaskRemoved={onTaskRemoved}
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
        tasks={tasks}
        onChanged={onChanged}
        onNavigate={onSelect}
        currentSelection={currentSelection}
      />
    </>
  );
}

/** The full panel of one entry: task proposals to decide on, a task with its tabs, or a session in a repo root. */
function EntryPanel({
  conn,
  entry,
  focus,
  currentSelection,
  sessions,
  tasks,
  onSelect,
  onChanged,
  onTaskRemoved,
}: {
  conn: Connection;
  entry: SessionEntry;
  focus: string | undefined;
  currentSelection: () => SessionSelection;
  sessions: readonly Session[];
  /** The tasks on the list, for the task panel's shared-files warning and the same-repo hint of proposals. */
  tasks: readonly Task[];
  onSelect: (selection: SessionSelection) => void;
  onChanged: () => void;
  onTaskRemoved: (task: string) => void;
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
        onChanged={onChanged}
        onRemoved={() => onTaskRemoved(entry.task.id)}
        onOpenTask={(id) => onSelect({ kind: "task", id })}
      />
    );
  return (
    <SessionPanel key={entry.session.id} conn={conn} session={entry.session} onChanged={onChanged} onClosed={() => onSelect(undefined)} />
  );
}

const NEXT_WAITING = { kind: "next-waiting" } as const;

const LAYOUT_LABELS: Record<SessionLayout, string> = { "1": "1", "2": "2", "4": "4", auto: "Auto" };

/** The layout switch above the right side: one entry with its full panel, or a grid of 2, 4 or all entries. */
function LayoutBar({ layout, onLayout, summary }: { layout: SessionLayout; onLayout: (layout: SessionLayout) => void; summary?: string }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-1.5">
      <span className="hud-label">Layout</span>
      <fieldset aria-label="Layout" className="flex overflow-hidden rounded-md border">
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
      <span className="text-muted-foreground ml-auto font-mono text-2xs">
        {`${sessionShortcutLabel({ kind: "position", position: 1 }, IS_MAC)}…${SHORTCUT_POSITIONS} select · ${sessionShortcutLabel(NEXT_WAITING, IS_MAC)} next waiting`}
      </span>
    </div>
  );
}

/** Nagłówek wybranej sesji (repo, stan, nad czym pracuje, przyciski) i jej terminal. */
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
  const dismiss = useAction(
    () => post(conn, agentsApi.dismiss, { session: session.id }),
    () => {
      onClosed();
      onChanged();
    },
  );
  const action = live ? stop : dismiss;
  return (
    <>
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm font-medium">{session.repo}</span>
            <span className="text-muted-foreground text-xs">
              <StatusLabel {...sessionStateLabel(session)} />
            </span>
            <span className="text-muted-foreground text-xs">{relativeTime(session.startedAt, new Date())}</span>
          </span>
          {session.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
        </div>
        {action.error && <span className="text-destructive max-w-xs truncate text-xs">{action.error}</span>}
        {live ? (
          <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending || session.run.kind === "stopping"}>
            <Square /> Stop
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={dismiss.run} disabled={dismiss.pending}>
            <X /> Close
          </Button>
        )}
      </header>
      <SessionTerminal conn={conn} session={session.id} live={live} focused />
    </>
  );
}

/**
 * Nowe zadanie albo sesja: repo z folderu z projektami i polecenie dla agenta. Z poleceniem powstaje zadanie
 * w osobnym worktree (ADR-31), bez niego zwykła sesja w korzeniu repo (ADR-26).
 */
function NewSession({
  conn,
  worktreesDir,
  onStarted,
  onCancel,
}: {
  conn: Connection;
  worktreesDir: string;
  onStarted: (selection: SessionSelection) => void;
  onCancel?: () => void;
}) {
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const repos = useRemote(load);
  const [repo, setRepo] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const chosen = repo ?? repos.data?.repos[0]?.id;
  const createTask = useAction(
    (repo: string) => post(conn, agentsApi.createTask, { repo, prompt }),
    (task) => onStarted({ kind: "task", id: task.id }),
  );
  const start = useAction(
    (repo: string) => post(conn, agentsApi.start, { repo }),
    (session) => onStarted({ kind: "session", id: session.id }),
  );
  const pending = createTask.pending || start.pending;
  const error = createTask.error ?? start.error;

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      <h3 className="hud-label">New task for the agent</h3>
      <p className="text-muted-foreground max-w-prose text-sm">
        Trackwall creates a new branch from the default branch of the chosen repo in a separate worktree and starts Copilot CLI there with
        your prompt, so several tasks in one repo stay out of each other's way. The session runs in a terminal owned by the daemon, also
        after you close the window, and the Changes tab shows what the agent changes.
      </p>
      {repos.error && <ErrorWithRetry message={repos.error} onRetry={repos.reload} />}
      {repos.data && repos.data.repos.length === 0 && (
        <p className="text-muted-foreground text-sm">The projects folder has no repos. Set the folder or clone a repo in Repos.</p>
      )}
      {repos.data && repos.data.repos.length > 0 && (
        <>
          <select
            aria-label="Repo for the task or session"
            value={chosen}
            onChange={(e) => setRepo(e.target.value)}
            className="border-input bg-card h-9 w-fit min-w-48 rounded-md border px-3 text-sm"
          >
            {repos.data.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
          <Textarea
            aria-label="Prompt for the agent"
            placeholder="What the agent should do, e.g. “Add email validation to the sign-up form, with a test”"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={TASK_PROMPT_MAX}
            rows={5}
          />
          {chosen && (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => createTask.run(chosen)} disabled={pending || prompt.trim() === ""}>
                <GitBranch /> Create task
              </Button>
              <Button variant="outline" onClick={() => start.run(chosen)} disabled={pending}>
                <Play /> Session in the repo, no task
              </Button>
              {onCancel && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </div>
          )}
          <p className="text-muted-foreground max-w-prose text-xs">
            Copilot CLI asks you to trust every new folder, including every worktree. To skip that prompt for each task, add{" "}
            <span className="text-foreground font-mono">{worktreesDir}</span> to <span className="font-mono">trustedFolders</span> in{" "}
            <span className="font-mono">~/.copilot/config.json</span>; trust covers subfolders.
          </p>
        </>
      )}
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
    </div>
  );
}
