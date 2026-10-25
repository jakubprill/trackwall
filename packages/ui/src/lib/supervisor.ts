import { isSupervisor, type Session, type SessionList } from "@trackwall/protocol";
import type { SessionSelection } from "./session-entries.ts";

/**
 * The supervisor (ADR-58): the one Copilot CLI session in the projects folder, above the sessions of all repos. It is
 * not an entry of the Sessions list; it has its own panel on the right of every view, and what it delegated sits under
 * its heading in the list.
 */

/** The supervisor the panel shows: the running one, otherwise the newest that has ended; `undefined` without one. */
export function currentSupervisor(list: SessionList | undefined): Session | undefined {
  const supervisors = list?.sessions.filter(isSupervisor) ?? [];
  // The list goes newest first.
  return supervisors.find((s) => s.run.kind !== "exited") ?? supervisors[0];
}

/** The selection points at a supervisor session, which opens in its panel instead of the Sessions view. */
export function selectsSupervisor(list: SessionList | undefined, selection: SessionSelection): boolean {
  if (selection?.kind !== "session") return false;
  return list?.sessions.some((s) => s.id === selection.id && isSupervisor(s)) === true;
}

/** The supervisor's task proposals that wait for your decision, from every supervisor session (ADR-58). */
export function supervisorProposals(list: SessionList | undefined): number {
  return list?.proposals.filter((p) => p.proposedBy.supervisor).length ?? 0;
}
