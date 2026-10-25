import { isSupervisor, type Session, type SessionList } from "@trackwall/protocol";
import { type SessionRow, type SessionSelection, workCount } from "./session-entries.ts";

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
  };
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
