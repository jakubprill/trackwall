import { agentsApi, countLabel, type Session } from "@trackwall/protocol";
import { BellRing, Crown, PanelRightClose, PanelRightOpen, Play, Square } from "lucide-react";
import { type FocusEvent, useEffect, useState } from "react";
import { SessionTerminal } from "@/components/SessionTerminal";
import { StatusLabel } from "@/components/StatusLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { IS_MAC } from "@/lib/platform";
import {
  entryId,
  entrySelection,
  entrySession,
  proposalsName,
  type SessionEntry,
  type SessionRow,
  type SessionSelection,
  taskName,
} from "@/lib/session-entries";
import { sessionShortcutLabel } from "@/lib/session-shortcut";
import { isLive, PROPOSAL_STATUS, SUPERVISOR, sessionPlace, sessionStateLabel } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";

const SHORTCUT = sessionShortcutLabel({ kind: "supervisor" }, IS_MAC);

/**
 * The supervisor panel (ADR-58) on the right of every view: the terminal of the one session above all repos, what it
 * delegated, and a start button while there is none. Pinned, it takes a column next to the view; folded, a narrow
 * strip that still shows when the supervisor or its proposals wait for you. `focusRequest` grows with every Alt+0 or
 * jump to the supervisor, which unfolds the panel and puts the keyboard in its terminal.
 */
export function SupervisorPanel({
  conn,
  supervisor,
  work,
  waitingProposals,
  pinned,
  onPinned,
  focusRequest,
  onOpenInSessions,
  onChanged,
}: {
  conn: Connection;
  supervisor: Session | undefined;
  /** The rows under the supervisor heading of the Sessions list. */
  work: readonly SessionRow[];
  waitingProposals: number;
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
  focusRequest: number;
  onOpenInSessions: (selection: SessionSelection) => void;
  onChanged: () => void;
}) {
  // The terminal counts as in front of the user (ADR-47) only while the keyboard is in the panel.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focusRequest > 0) setFocused(true);
  }, [focusRequest]);
  const waits = supervisor?.needsAttention === true || waitingProposals > 0;
  if (!pinned) return <FoldedSupervisor waits={waits} onUnfold={() => onPinned(true)} />;
  const leave = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocused(false);
  };
  return (
    <aside
      aria-label={SUPERVISOR}
      className="bg-card flex w-supervisor min-w-0 shrink-0 flex-col border-l"
      onFocus={() => setFocused(true)}
      onBlur={leave}
    >
      <SupervisorHeader conn={conn} supervisor={supervisor} onChanged={onChanged} onFold={() => onPinned(false)} />
      <DelegatedWork work={work} waitingProposals={waitingProposals} onOpen={onOpenInSessions} />
      {supervisor ? (
        <SessionTerminal key={supervisor.id} conn={conn} session={supervisor.id} live={isLive(supervisor)} focused={focused} />
      ) : (
        <NoSupervisor />
      )}
    </aside>
  );
}

/** The folded panel: a strip at the right edge that unfolds it, with a bell while something of the supervisor waits. */
function FoldedSupervisor({ waits, onUnfold }: { waits: boolean; onUnfold: () => void }) {
  return (
    <aside aria-label={SUPERVISOR} className="bg-card flex w-activity-bar shrink-0 flex-col items-center gap-2 border-l py-3">
      <Button
        variant="ghost"
        size="icon"
        onClick={onUnfold}
        aria-label={`Pin the supervisor panel open${waits ? ", something is waiting for you" : ""}`}
        aria-keyshortcuts="Alt+0"
        title={`Pin the supervisor panel open (${SHORTCUT})`}
      >
        <PanelRightOpen />
      </Button>
      <Crown className={cn("size-4", waits ? "text-warning" : "text-primary")} aria-hidden />
      {waits && <BellRing className="text-warning size-4" aria-hidden />}
    </aside>
  );
}

/** Name, state and what it works on; Stop while it runs, and a new start once it has ended or before the first. */
function SupervisorHeader({
  conn,
  supervisor,
  onChanged,
  onFold,
}: {
  conn: Connection;
  supervisor: Session | undefined;
  onChanged: () => void;
  onFold: () => void;
}) {
  const start = useAction(() => post(conn, agentsApi.startSupervisor, {}), onChanged);
  const stop = useAction((id: string) => post(conn, agentsApi.stop, { session: id }), onChanged);
  const running = supervisor !== undefined && isLive(supervisor) ? supervisor : undefined;
  const error = running ? stop.error : start.error;
  return (
    <header className="flex flex-col gap-1 border-b px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <Crown className="text-primary size-4 shrink-0" aria-hidden />
        <h2 className="hud-label">{SUPERVISOR}</h2>
        {supervisor && (
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            <StatusLabel {...sessionStateLabel(supervisor)} />
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => stop.run(running.id)}
              disabled={stop.pending || running.run.kind === "stopping"}
            >
              <Square /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={() => start.run()} disabled={start.pending}>
              <Play /> {supervisor ? "Start again" : "Start supervisor"}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onFold} aria-label="Fold the supervisor panel" title="Fold the panel">
            <PanelRightClose />
          </Button>
        </span>
      </div>
      {supervisor?.windowTitle && <span className="text-muted-foreground truncate text-xs">{supervisor.windowTitle}</span>}
      {error && <span className="text-destructive text-xs">{error}</span>}
    </header>
  );
}

/** What the supervisor delegated, as on the Sessions list under its heading; a row opens it in Sessions. */
function DelegatedWork({
  work,
  waitingProposals,
  onOpen,
}: {
  work: readonly SessionRow[];
  waitingProposals: number;
  onOpen: (selection: SessionSelection) => void;
}) {
  if (work.length === 0) return null;
  const tasks = work.filter((r) => r.entry.kind === "task").length;
  return (
    <section aria-label="Delegated by the supervisor" className="flex max-h-48 flex-col gap-1 overflow-y-auto border-b px-2 py-2">
      <p className="hud-label flex items-center gap-2 px-2">
        Delegated
        {waitingProposals > 0 && (
          <Badge variant="outline">{countLabel(waitingProposals, { one: "proposal", other: "proposals" })} waiting</Badge>
        )}
        {tasks > 0 && <span className="text-muted-foreground">{countLabel(tasks, { one: "task", other: "tasks" })}</span>}
      </p>
      {work.map((row) => (
        <WorkRow key={entryId(row.entry)} row={row} onOpen={() => onOpen(entrySelection(row.entry))} />
      ))}
    </section>
  );
}

function WorkRow({ row, onOpen }: { row: SessionRow; onOpen: () => void }) {
  const { entry } = row;
  const session = entrySession(entry);
  const status = entry.kind === "proposals" ? PROPOSAL_STATUS : session ? sessionStateLabel(session) : { label: "no session" };
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("hover:bg-accent flex min-w-0 items-center gap-3 rounded-md px-2 py-1 text-left text-xs", row.depth > 1 && "pl-6")}
    >
      <span className="min-w-0 flex-1 truncate">{workName(entry)}</span>
      <StatusLabel {...status} />
    </button>
  );
}

/** A row's name: the repo and title of a task or a proposal, the count of a group of proposals. */
function workName(entry: SessionEntry): string {
  if (entry.kind === "proposals") return proposalsName(entry.proposals);
  if (entry.kind === "task") return `${entry.task.repo} · ${taskName(entry.task)}`;
  return sessionPlace(entry.session);
}

function NoSupervisor() {
  return (
    <div className="text-muted-foreground flex flex-col gap-3 p-4 text-sm">
      <p>
        The supervisor is one Copilot CLI session above all your repos. Tell it what you want done; it plans the work, proposes a task for
        each repo, and follows the agents that run them.
      </p>
      <p>Every task it proposes waits for your approval in Sessions, and nothing starts without it.</p>
    </div>
  );
}
