import { describe, expect, test } from "bun:test";
import { type FolderTerminal, PROJECTS_FOLDER_PLACE } from "@trackwall/protocol";
import { reopensOnOpen, shownTerminal, terminalAt } from "../src/lib/folder-terminals.ts";

const RUNNING: FolderTerminal["run"] = { kind: "running", runId: "r1", startedAt: "2026-11-03T10:00:00.000Z", pid: 7 };
const ROOT: FolderTerminal = { id: "11111111-1111-4111-8111-111111111111", repo: "shop", task: null, run: RUNNING };
const WORKTREE: FolderTerminal = { id: "22222222-2222-4222-8222-222222222222", repo: "shop", task: "t1", run: RUNNING };
const PROJECTS: FolderTerminal = { id: "33333333-3333-4333-8333-333333333333", repo: null, task: null, run: RUNNING };

describe("a place's folder terminal", () => {
  test("a repo root and a task's worktree of the same repo are different places", () => {
    expect(terminalAt([ROOT, WORKTREE], { repo: "shop", task: null })).toBe(ROOT);
    expect(terminalAt([ROOT, WORKTREE], { repo: "shop", task: "t1" })).toBe(WORKTREE);
  });

  test("the projects folder is a place of its own, not any repo in it", () => {
    expect(terminalAt([ROOT, PROJECTS], PROJECTS_FOLDER_PLACE)).toBe(PROJECTS);
    expect(terminalAt([ROOT], PROJECTS_FOLDER_PLACE)).toBeUndefined();
    expect(terminalAt([PROJECTS], { repo: "shop", task: null })).toBeUndefined();
  });

  test("a place without a terminal has none", () => {
    expect(terminalAt([ROOT], { repo: "billing", task: null })).toBeUndefined();
    expect(terminalAt([ROOT], { repo: "shop", task: "t2" })).toBeUndefined();
  });
});

describe("opening a Shell tab", () => {
  test("starts no shell where none runs, so a tab passed by with Ctrl+PageDown leaves nothing running", () => {
    expect(reopensOnOpen({ loaded: true, hasLiveShell: false, alreadyAsked: false })).toBe(false);
  });

  test("asks the daemon once for a live shell, which it hands back or moves to a changed projects folder", () => {
    expect(reopensOnOpen({ loaded: true, hasLiveShell: true, alreadyAsked: false })).toBe(true);
    expect(reopensOnOpen({ loaded: true, hasLiveShell: true, alreadyAsked: true })).toBe(false);
    expect(reopensOnOpen({ loaded: false, hasLiveShell: false, alreadyAsked: false })).toBe(false);
  });
});

describe("closing a Shell tab's shell", () => {
  const OLD = ROOT;
  const FRESH: FolderTerminal = { ...ROOT, id: "44444444-4444-4444-8444-444444444444" };

  test("hides the shell at once, before the daemon confirms its end", () => {
    expect(shownTerminal({ listed: OLD, started: undefined, closing: new Set([OLD.id]) })).toBeUndefined();
  });

  test("shows a new shell started while the list still names the old one being closed", () => {
    expect(shownTerminal({ listed: OLD, started: FRESH, closing: new Set([OLD.id]) })).toBe(FRESH);
  });

  test("prefers the list's terminal to the start's answer, as the list says what happened to it since", () => {
    const ended: FolderTerminal = {
      ...FRESH,
      run: {
        kind: "exited",
        runId: "r1",
        startedAt: "2026-11-03T10:00:00.000Z",
        endedAt: "2026-11-03T10:05:00.000Z",
        exitCode: 0,
        signal: null,
        stoppedByUser: false,
        lastLines: [],
      },
    };
    expect(shownTerminal({ listed: ended, started: FRESH, closing: new Set() })).toBe(ended);
  });
});
