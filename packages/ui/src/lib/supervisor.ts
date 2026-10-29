import { type DayStartRun, isSupervisor, type Session, type SessionList, type SupervisorConversation } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";
import { type SessionRow, type SessionSelection, workCount } from "./session-entries.ts";
import { sessionStateLabel } from "./session-state.ts";

/**
 * The supervisor (ADR-58): the one Copilot CLI session in the projects folder, above the sessions of all repos. It is
 * not an entry of the Sessions list; it has its own panel on the right of every view, and what it delegated sits under
 * its heading in the list.
 */

/** Everything the panel and the list heading show about the supervisor, computed once from the list and its rows. */
export interface SupervisorSummary {
  /** The running supervisor, otherwise the newest that has ended; `undefined` without one. */
  session: Session | undefined;
  /** The rows under its heading, also the work its tasks delegated further. */
  work: SessionRow[];
  /** Tasks and proposals directly under it, counted like the "main" badge: a group counts each proposal. */
  delegated: number;
  /** The task proposals under it, its own and those of the tasks it delegated, that wait for your decision. */
  waitingProposals: number;
  /** The supervisor session itself waits for you, like a session's bell on the list. */
  sessionWaits: boolean;
  /** The supervisor session or a proposal under it waits for you: the bell of the folded panel. */
  waits: boolean;
  /** The list shows the heading: there is a supervisor or work of one. */
  listed: boolean;
  /** Copilot CLI keeps the conversation of the last supervisor, so a start can go on with it (ADR-96). */
  resumable: boolean;
}

export function supervisorSummary(list: SessionList | undefined, rows: readonly SessionRow[]): SupervisorSummary {
  const supervisors = list?.sessions.filter(isSupervisor) ?? [];
  // The list goes newest first.
  const session = supervisors.find((s) => s.run.kind !== "exited") ?? supervisors[0];
  const work = rows.filter((r) => r.supervised);
  const sum = (items: readonly SessionRow[]) => items.reduce((total, r) => total + workCount(r.entry), 0);
  const waitingProposals = sum(work.filter((r) => r.entry.kind === "proposals"));
  const sessionWaits = session?.needsAttention === true;
  return {
    session,
    work,
    delegated: sum(work.filter((r) => r.depth === 1)),
    waitingProposals,
    sessionWaits,
    waits: sessionWaits || waitingProposals > 0,
    listed: session !== undefined || work.length > 0,
    resumable: list?.lastSupervisor != null,
  };
}

/** The ways to start the supervisor (ADR-126): Start my day, the last conversation again, or a new empty one. */
type SupervisorStartKind = "day" | SupervisorConversation;

/** One way to start the supervisor as the panel's start card offers it: what it is called and what it does. */
export interface SupervisorChoice {
  kind: SupervisorStartKind;
  title: string;
  description: string;
  button: string;
}

const DAY: SupervisorChoice = {
  kind: "day",
  title: "Start my day",
  description: "Syncs every repo, writes what changed since your last day start, and starts a new conversation with that briefing.",
  button: "Start my day",
};
const DAY_AGAIN: SupervisorChoice = { ...DAY, title: "Start my day again", button: "Start my day again" };
const LAST: SupervisorChoice = {
  kind: "last",
  title: "Continue the last conversation",
  description: "Goes back to the supervisor's last conversation, with everything said so far.",
  button: "Continue",
};
const NEW: SupervisorChoice = {
  kind: "new",
  title: "New conversation",
  description: "Starts an empty conversation, without a sync or a briefing.",
  button: "New conversation",
};

/**
 * The start card's choices while no supervisor runs (ADR-126), the main one first: Start my day until a day start has
 * started the supervisor today, then Continue while the last conversation can go on (ADR-96). New is always there.
 */
export function supervisorChoices(
  supervisor: Pick<SupervisorSummary, "resumable">,
  dayRun: DayStartRun | null | undefined,
  now: Date,
): SupervisorChoice[] {
  const dayDoneToday = dayRun?.supervisor != null && sameDay(new Date(dayRun.startedAt), now);
  const day = dayDoneToday ? DAY_AGAIN : DAY;
  if (!supervisor.resumable) return [day, NEW];
  return dayDoneToday ? [LAST, day, NEW] : [day, LAST, NEW];
}

/** The same calendar day where the user is. */
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The supervisor's state in the panel's header (ADR-126): starting the day while a day start runs, not running without
 * a supervisor, the state of an ended one with the time it ended at, otherwise the session's own state.
 */
export function supervisorStateLabel(
  session: Session | undefined,
  dayStarting: boolean,
  clock: (iso: string) => string,
): { tone?: StatusTone; label: string } {
  if (dayStarting) return { tone: "warning", label: "starting your day…" };
  if (session === undefined) return { label: "not running" };
  const state = sessionStateLabel(session);
  return session.run.kind === "exited" ? { ...state, label: `${state.label} at ${clock(session.run.endedAt)}` } : state;
}

/**
 * Showing the panel (Alt+0, a jump to the supervisor) gives its terminal the keyboard. Without a supervisor session
 * there is no terminal to take it, so the keyboard stays where it is, and the terminal selected in a view stays in front.
 */
export function showingTakesKeyboard(supervisor: SupervisorSummary): boolean {
  return supervisor.session !== undefined;
}

/** The selection points at a supervisor session, which opens in its panel instead of the Sessions view. */
export function selectsSupervisor(list: SessionList | undefined, selection: SessionSelection): boolean {
  if (selection?.kind !== "session") return false;
  return list?.sessions.some((s) => s.id === selection.id && isSupervisor(s)) === true;
}
