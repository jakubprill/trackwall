import { describe, expect, test } from "bun:test";
import type { Task, TaskProposal } from "@trackwall/protocol";
import { selectionAfterDecision, startProposals } from "../src/lib/proposal-decisions.ts";

function proposal(id: string): TaskProposal {
  return {
    id,
    repo: "billing",
    title: `Task ${id}`,
    prompt: `do ${id}`,
    proposedBy: { session: "main" },
    createdAt: "2026-10-25T10:00:00Z",
  };
}

function task(id: string): Task {
  return {
    id,
    repo: "billing",
    prompt: `do ${id}`,
    branch: `trackwall/${id}`,
    baseBranch: "main",
    base: "a".repeat(40),
    worktree: `/w/billing/${id}`,
    createdAt: "2026-10-25T10:01:00Z",
    title: `Task ${id}`,
    proposedBy: { session: "main" },
    summary: null,
  };
}

describe("starting several task proposals", () => {
  test("starts them one after another in the given order, and a failed start does not stop the rest", async () => {
    const calls: string[] = [];
    const result = await startProposals(
      [
        { id: "p1", prompt: "do p1" },
        { id: "p2", prompt: "do p2" },
        { id: "p3", prompt: "do p3, edited" },
      ],
      async ({ id, prompt }) => {
        calls.push(`${id}: ${prompt}`);
        if (id === "p2") throw new Error("the repo has no default branch");
        return task(id);
      },
    );
    expect(calls).toEqual(["p1: do p1", "p2: do p2", "p3: do p3, edited"]);
    expect(result.started.map((t) => t.id)).toEqual(["p1", "p3"]);
    expect(result.failed).toEqual(new Map([["p2", "the repo has no default branch"]]));
  });
});

describe("where the Sessions view goes after a decision", () => {
  const proposals = [proposal("p1"), proposal("p2"), proposal("p3")];

  test("to the next proposal of the same session that still waits", () => {
    expect(selectionAfterDecision(proposals, new Set(["p1"]), "main", [task("p1")])).toEqual({ kind: "proposal", id: "p2" });
    expect(selectionAfterDecision(proposals, new Set(["p2"]), "main", [])).toEqual({ kind: "proposal", id: "p1" });
  });

  test("when none is left, to the first task that has just started", () => {
    expect(selectionAfterDecision(proposals, new Set(["p1", "p2", "p3"]), "main", [task("p2"), task("p3")])).toEqual({
      kind: "task",
      id: "p2",
    });
  });

  test("after rejecting the last one, to the session that proposed them, which waits for the answer", () => {
    expect(selectionAfterDecision([proposal("p1")], new Set(["p1"]), "main", [])).toEqual({ kind: "session", id: "main" });
    expect(selectionAfterDecision([proposal("p1")], new Set(["p1"]), null, [])).toBeUndefined();
  });
});
