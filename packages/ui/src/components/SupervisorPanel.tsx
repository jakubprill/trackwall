import { agentsApi, countLabel } from "@trackwall/protocol";
import { BellRing, Crown, PanelRightClose, PanelRightOpen, Play, Square, Sunrise } from "lucide-react";
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { SessionTerminal } from "@/components/SessionTerminal";
import { StatusLabel } from "@/components/StatusLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { dayStartFailure, dayStartLabel } from "@/lib/day-start";
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
import { ariaSessionShortcut, SUPERVISOR_SHORTCUT, sessionShortcutLabel } from "@/lib/session-shortcut";
import { isLive, PROPOSAL_STATUS, SUPERVISOR, sessionPlace, sessionStateLabel } from "@/lib/session-state";
import type { SupervisorSummary } from "@/lib/supervisor";
import { useAction } from "@/lib/use-action";
import { useDayStart } from "@/lib/use-day-start";
import { cn } from "@/lib/utils";

const SHORTCUT = sessionShortcutLabel(SUPERVISOR_SHORTCUT, IS_MAC);

/**
 * The supervisor panel (ADR-58) on the right of every view: the terminal of the one session above all repos, what it
 * delegated, and a start button while there is none. Pinned, it takes a column next to the view; folded, a narrow
 * strip that still shows when the supervisor or its proposals wait for you. `focused` says the keyboard is in the
 * panel: `App` sets it on Alt+0 or a jump to the supervisor, and the panel reports the keyboard coming and going.
 */
export function SupervisorPanel({
  conn,
  supervisor,
  pinned,
  onPinned,
  focused,
  onFocusedChange,
  onOpenInSessions,
  onChanged,
}: {
  conn: Connection;
  supervisor: SupervisorSummary;
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
  focused: boolean;
  onFocusedChange: (focused: boolean) => void;
  onOpenInSessions: (selection: SessionSelection) => void;
  onChanged: () => void;
}) {
  const { session } = supervisor;
  const panel = useRef<HTMLElement>(null);
  // Focus that lands anywhere outside the panel takes the keyboard out of it. A blur would say the same, but none
  // comes when the focused terminal is removed (a reconnect, a supervisor gone after a daemon restart).
  useEffect(() => {
    const moved = (event: Event) => {
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) onFocusedChange(false);
    };
    document.addEventListener("focusin", moved);
    return () => document.removeEventListener("focusin", moved);
  }, [onFocusedChange]);
  if (!pinned) return <FoldedSupervisor supervisor={supervisor} onUnfold={() => onPinned(true)} />;
  const leave = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) onFocusedChange(false);
  };
  const fold = () => {
    onFocusedChange(false);
    onPinned(false);
  };
  return (
    <aside
      ref={panel}
      aria-label={SUPERVISOR}
      className="bg-card flex w-supervisor min-w-0 shrink-0 flex-col border-l"
      onFocus={() => onFocusedChange(true)}
      onBlur={leave}
    >
      <SupervisorHeader conn={conn} supervisor={supervisor} onChanged={onChanged} onFold={fold} />
      <DelegatedWork work={supervisor.work} onOpen={onOpenInSessions} />
      {session ? (
        <SessionTerminal key={session.id} conn={conn} session={session.id} live={isLive(session)} selected={focused} />
      ) : (
        <NoSupervisor />
      )}
    </aside>
  );
}

/** The folded panel: a strip at the right edge that unfolds it, with a bell while something of the supervisor waits. */
function FoldedSupervisor({ supervisor, onUnfold }: { supervisor: SupervisorSummary; onUnfold: () => void }) {
  const { waits, waitingProposals } = supervisor;
  return (
    <aside aria-label={SUPERVISOR} className="bg-card flex w-activity-bar shrink-0 flex-col items-center gap-2 border-l py-3">
      <Button
        variant="ghost"
        size="icon"
        onClick={onUnfold}
        aria-label={`Pin the supervisor panel open${waits ? ", something is waiting for you" : ""}`}
        aria-keyshortcuts={ariaSessionShortcut(SUPERVISOR_SHORTCUT)}
        title={`Pin the supervisor panel open (${SHORTCUT})`}
      >
        <PanelRightOpen />
      </Button>
      <Crown className={cn("size-4", waits ? "text-warning" : "text-primary")} aria-hidden />
      {waits && <BellRing className="text-warning size-4" aria-hidden />}
      {waitingProposals > 0 && <ProposalsWaiting count={waitingProposals} />}
    </aside>
  );
}

/** Name, state and what it works on; Stop while it runs, and Start my day or a plain start once it has ended or before the first. */
function SupervisorHeader({
  conn,
  supervisor,
  onChanged,
  onFold,
}: {
  conn: Connection;
  supervisor: SupervisorSummary;
  onChanged: () => void;
  onFold: () => void;
}) {
  const { session, waitingProposals } = supervisor;
  const start = useAction(() => post(conn, agentsApi.startSupervisor, {}), onChanged);
  const stop = useAction((id: string) => post(conn, agentsApi.stop, { session: id }), onChanged);
  const day = useDayStart(conn, onChanged);
  const running = session !== undefined && isLive(session) ? session : undefined;
  // Only the error of the start the user pressed last: an older one of the other button says nothing about now.
  const [lastStart, setLastStart] = useState<"supervisor" | "day">("day");
  const startError = lastStart === "supervisor" ? start.error : (day.error ?? dayStartFailure(day.run, session?.startedAt));
  const error = running ? stop.error : startError;
  return (
    <header className="flex flex-col gap-1 border-b px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <Crown className="text-primary size-4 shrink-0" aria-hidden />
        <h2 className="hud-label">{SUPERVISOR}</h2>
        {session && (
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            <StatusLabel {...sessionStateLabel(session)} />
          </span>
        )}
        {waitingProposals > 0 && <ProposalsWaiting count={waitingProposals} />}
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
            <>
              <Button
                size="sm"
                onClick={() => {
                  setLastStart("day");
                  day.start();
                }}
                disabled={day.running || start.pending}
                title="Sync every repo and get a briefing"
              >
                <Sunrise /> {dayStartLabel(day.run)}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLastStart("supervisor");
                  start.run();
                }}
                disabled={start.pending || day.running}
              >
                <Play /> {session ? "Start again" : "Start supervisor"}
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" onClick={onFold} aria-label="Fold the supervisor panel" title="Fold the panel">
            <PanelRightClose />
          </Button>
        </span>
      </div>
      {session?.windowTitle && <span className="text-muted-foreground truncate text-xs">{session.windowTitle}</span>}
      {error && <span className="text-destructive text-xs">{error}</span>}
    </header>
  );
}

/** What the supervisor delegated, as on the Sessions list under its heading; a row opens it in Sessions. */
function DelegatedWork({ work, onOpen }: { work: readonly SessionRow[]; onOpen: (selection: SessionSelection) => void }) {
  if (work.length === 0) return null;
  return (
    <section aria-label="Delegated by the supervisor" className="flex max-h-48 flex-col gap-1 overflow-y-auto border-b px-2 py-2">
      <p className="hud-label px-2">Delegated</p>
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

/** The supervisor's proposals that wait for your decision, in the header and on the folded strip. */
function ProposalsWaiting({ count }: { count: number }) {
  const label = `${countLabel(count, { one: "proposal", other: "proposals" })} under the supervisor waiting for your decision`;
  return (
    <Badge variant="outline" className="text-warning" aria-label={label} title={label}>
      {count}
    </Badge>
  );
}

function NoSupervisor() {
  return (
    <div className="text-muted-foreground flex flex-col gap-3 p-4 text-sm">
      <p>
        The supervisor is one Copilot CLI session above all your repos. Tell it what you want done; it plans the work, proposes a task for
        each repo, and follows the agents that run them.
      </p>
      <p>Every task it proposes waits for your approval in Sessions, and nothing starts without it.</p>
      <p>
        Start my day syncs every repo first, then starts the supervisor with a briefing of what changed since your last day start and what
        waits for you.
      </p>
    </div>
  );
}
