import {
  agentsApi,
  countLabel,
  type Session,
  type SessionList,
  TASK_PROMPT_MAX,
  type Task,
  type TaskProposal,
  workspaceApi,
} from "@trackwall/protocol";
import { BellRing, GitBranch, Lightbulb, Play, Plus, Square, X } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime, twoDigits } from "@/lib/format";
import {
  entryId,
  entrySelection,
  entrySession,
  findEntry,
  type SessionEntry,
  type SessionRow,
  type SessionSelection,
  sessionRows,
  taskName,
} from "@/lib/session-entries";
import { isLive, nextWaiting, PROPOSAL_STATUS, sessionStateLabel, waitingCount } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { actionIsNewer, type RemoteHandle, useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { ProposalPanel } from "./ProposalPanel.tsx";
import { SessionTerminal } from "./SessionTerminal.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

/**
 * Widok „Sesje” (§4.4, ADR-26, ADR-31): kilka sesji Copilot CLI naraz, każda w repo z folderu z projektami albo
 * w worktree zadania. Po lewej lista sesji i zadań ze stanem i skokiem do następnej sesji, która czeka na Ciebie,
 * a nad nimi propozycje zadań od agentów (ADR-39); po prawej terminal wybranej sesji, przy zadaniu także jego zmiany,
 * a przy propozycji jej polecenie do zatwierdzenia. Listę odpytuje `App`, bo liczba czekających
 * sesji jest też na pasku widoków.
 */
export function SessionsView({
  conn,
  sessions,
  selected,
  onSelect,
}: {
  conn: Connection;
  sessions: RemoteHandle<SessionList>;
  selected: SessionSelection;
  onSelect: (selection: SessionSelection) => void;
}) {
  const list = sessions.data?.sessions ?? [];
  // Zakończone zadanie znika od razu, a nie po odświeżeniu listy, żeby panel nie pokazał go znowu bez worktree.
  const [removed, setRemoved] = useState<{ task: string; afterLoad: number }>();
  const hidden = removed && actionIsNewer(removed.afterLoad, sessions.loadNumber) ? removed.task : undefined;
  const rows = sessions.data ? sessionRows({ ...sessions.data, tasks: sessions.data.tasks.filter((t) => t.id !== hidden) }) : [];
  const entries = rows.map((r) => r.entry);
  const current = findEntry(entries, selected);
  const show = (id: string) => onSelect({ kind: "session", id });
  const next = nextWaiting(list, entrySession(current)?.id);
  const waiting = waitingCount(list);

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
            <Button variant="outline" size="sm" className="w-full" onClick={() => show(next.id)}>
              <BellRing /> {waiting === 1 ? "A session is waiting for you" : `Next waiting (${waiting})`}
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
        {current?.kind === "proposal" && (
          <ProposalPanel
            key={current.proposal.id}
            conn={conn}
            proposal={current.proposal}
            sessions={list}
            onApproved={(task) => {
              onSelect({ kind: "task", id: task.id });
              sessions.reload();
            }}
            onRejected={() => {
              onSelect(undefined);
              sessions.reload();
            }}
          />
        )}
        {current?.kind === "task" && (
          <TaskPanel
            key={current.task.id}
            conn={conn}
            task={current.task}
            session={current.session}
            sessions={list}
            onChanged={sessions.reload}
            onRemoved={() => {
              setRemoved({ task: current.task.id, afterLoad: sessions.sentLoads() });
              onSelect(undefined);
              sessions.reload();
            }}
          />
        )}
        {current?.kind === "session" && (
          <SessionPanel
            key={current.session.id}
            conn={conn}
            session={current.session}
            onChanged={sessions.reload}
            onClosed={() => onSelect(undefined)}
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
      {entry.kind === "proposal" ? (
        <ProposalListItem proposal={entry.proposal} position={position} active={active} onSelect={onSelect} />
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
  entry: Exclude<SessionEntry, { kind: "proposal" }>;
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
      className={cn(
        "flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent border-primary/25 hud-active-edge",
      )}
    >
      <span className="text-muted-foreground text-2xs w-5 shrink-0 pt-0.5 text-right font-mono">{twoDigits(position)}</span>
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

/** Propozycja zadania na liście: czeka na Twoją decyzję, więc ma ton ostrzeżenia jak sesja, która czeka. */
function ProposalListItem({
  proposal,
  position,
  active,
  onSelect,
}: {
  proposal: TaskProposal;
  position: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent border-primary/25 hud-active-edge",
      )}
    >
      <span className="text-muted-foreground text-2xs w-5 shrink-0 pt-0.5 text-right font-mono">{twoDigits(position)}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{proposal.repo}</span>
          <Lightbulb className="text-warning size-3.5 shrink-0" aria-label="task proposal" />
        </span>
        <span className="text-muted-foreground truncate text-xs">{proposal.title}</span>
        <span className="text-xs">
          <StatusLabel {...PROPOSAL_STATUS} />
        </span>
      </span>
    </button>
  );
}

/**
 * Tytuł zadania z propozycji albo polecenie w jednej linii, z ikoną gałęzi, żeby zadanie odróżniało się od sesji
 * w korzeniu repo.
 */
function TaskLine({ task }: { task: Task }) {
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs" title={task.branch}>
      <GitBranch className="size-3 shrink-0" aria-label="task in a worktree" />
      <span className="truncate">{taskName(task)}</span>
    </span>
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
      <SessionTerminal conn={conn} session={session.id} live={live} />
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
