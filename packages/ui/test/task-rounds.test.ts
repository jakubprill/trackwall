import { describe, expect, test } from "bun:test";
import type { TaskRound } from "@trackwall/protocol";
import { roundNote, shownRound, undoConsequence } from "../src/lib/task-rounds.ts";

const NOW = new Date("2026-11-01T10:00:00Z");
const A = "a".repeat(40);
const B = "b".repeat(40);

const round = (number: number, changes: Partial<TaskRound> = {}): TaskRound => ({
  number,
  from: A,
  to: B,
  endedAt: "2026-11-01T09:58:00Z",
  roundCommit: B,
  outside: false,
  undoneAt: null,
  ...changes,
});

describe("what the Rounds tab says about a round (ADR-168)", () => {
  test("says when the round ended and who committed it", () => {
    expect(roundNote(round(1), NOW)).toBe("2 min ago · committed by Trackwall");
    expect(roundNote(round(1, { roundCommit: null }), NOW)).toBe("2 min ago · committed by the agent");
  });

  test("says that a round started on outside changes, and when it was undone", () => {
    expect(roundNote(round(2, { outside: true, undoneAt: "2026-11-01T09:59:30Z" }), NOW)).toBe(
      "2 min ago · committed by Trackwall · started on changes from outside the rounds · undone just now",
    );
  });

  test("shows the round the user picked while it is kept, otherwise the newest", () => {
    const rounds = [round(3), round(2), round(1)];
    expect(shownRound(rounds, 2)?.number).toBe(2);
    expect(shownRound(rounds, 9)?.number).toBe(3);
    expect(shownRound(rounds, null)?.number).toBe(3);
    expect(shownRound([], null)).toBeUndefined();
  });

  test("the undo's confirmation says where the worktree goes and that the agent hears of it", () => {
    expect(undoConsequence(3)).toBe(
      "The worktree and the task branch go back to where they were before round 3, and the agent is told. Trackwall cannot redo it.",
    );
  });
});
