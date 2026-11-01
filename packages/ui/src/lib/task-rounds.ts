import type { TaskRound } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";

/**
 * What the task's "Rounds" tab says about a round (ADR-168): when it ended, who committed it and whether it stands.
 * Without React, so the wording is tested on its own.
 */

/** A round's list lines change only every few seconds, when a turn of the agent ends. */
export const ROUNDS_POLL_MS = 5000;

/** The line under a round's number: when it ended, who committed it, and whether it was undone or started on outside changes. */
export function roundNote(round: TaskRound, now: Date): string {
  const parts = [
    relativeTime(round.endedAt, now),
    round.roundCommit === null ? "committed by the agent" : "committed by Trackwall",
    ...(round.outside ? ["started on changes from outside the rounds"] : []),
    ...(round.undoneAt === null ? [] : [`undone ${relativeTime(round.undoneAt, now)}`]),
  ];
  return parts.join(" · ");
}

/** The round whose diff the tab shows: the one the user picked, while it is kept, otherwise the newest. */
export function shownRound(rounds: readonly TaskRound[], picked: number | null): TaskRound | undefined {
  return rounds.find((r) => r.number === picked) ?? rounds[0];
}

/** What the undo's confirmation says will happen to the worktree. */
export function undoConsequence(round: number): string {
  return `The worktree and the task branch go back to where they were before round ${round}, and the agent is told. Trackwall cannot redo it.`;
}
