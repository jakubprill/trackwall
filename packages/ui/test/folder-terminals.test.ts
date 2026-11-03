import { describe, expect, test } from "bun:test";
import type { FolderTerminal } from "@trackwall/protocol";
import { startsOnOpen, terminalAt } from "../src/lib/folder-terminals.ts";

const RUNNING: FolderTerminal["run"] = { kind: "running", runId: "r1", startedAt: "2026-11-03T10:00:00.000Z", pid: 7 };
const ROOT: FolderTerminal = { id: "11111111-1111-4111-8111-111111111111", repo: "shop", task: null, run: RUNNING };
const WORKTREE: FolderTerminal = { id: "22222222-2222-4222-8222-222222222222", repo: "shop", task: "t1", run: RUNNING };

describe("a place's folder terminal", () => {
  test("a repo root and a task's worktree of the same repo are different places", () => {
    expect(terminalAt([ROOT, WORKTREE], { repo: "shop", task: null })).toBe(ROOT);
    expect(terminalAt([ROOT, WORKTREE], { repo: "shop", task: "t1" })).toBe(WORKTREE);
  });

  test("a place without a terminal has none", () => {
    expect(terminalAt([ROOT], { repo: "billing", task: null })).toBeUndefined();
    expect(terminalAt([ROOT], { repo: "shop", task: "t2" })).toBeUndefined();
  });
});

describe("opening a Shell tab", () => {
  test("starts the place's shell once the list came and shows none", () => {
    expect(startsOnOpen({ loaded: true, hasTerminal: false, alreadyAsked: false })).toBe(true);
  });

  test("waits for the list, keeps the shell that is there, and never starts a second time in the same tab", () => {
    expect(startsOnOpen({ loaded: false, hasTerminal: false, alreadyAsked: false })).toBe(false);
    expect(startsOnOpen({ loaded: true, hasTerminal: true, alreadyAsked: false })).toBe(false);
    expect(startsOnOpen({ loaded: true, hasTerminal: false, alreadyAsked: true })).toBe(false);
  });
});
