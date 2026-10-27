import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import { newSessionStart, sessionsInSameFolder } from "../src/lib/new-session.ts";

function session(id: string, over: Partial<Session>): Session {
  return {
    id,
    repo: "shop",
    supervisor: false,
    startedAt: "2026-10-27T10:00:00Z",
    run: { kind: "running", runId: id, startedAt: "2026-10-27T10:00:00Z", pid: 1 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    task: null,
    dialog: null,
    ...over,
  };
}

describe("what the New session form starts (ADR-100)", () => {
  test("a repo with its own worktree is a task with the trimmed prompt, and without a prompt nothing starts", () => {
    expect(newSessionStart("shop", true, "  Add a test \n")).toEqual({ kind: "task", repo: "shop", prompt: "Add a test" });
    expect(newSessionStart("shop", true, "   ")).toEqual({ kind: "needs-prompt" });
  });

  test("a repo without its own worktree is a session in its working copy, with the prompt as its first message when there is one", () => {
    expect(newSessionStart("shop", false, "Fix the build")).toEqual({ kind: "session", repo: "shop", prompt: "Fix the build" });
    expect(newSessionStart("shop", false, "")).toEqual({ kind: "session", repo: "shop", prompt: undefined });
  });

  test("the projects folder is a free session whatever the worktree choice says, since it has no worktree", () => {
    expect(newSessionStart(null, true, "")).toEqual({ kind: "session", repo: null, prompt: undefined });
    expect(newSessionStart(null, false, "Compare the two APIs")).toEqual({
      kind: "session",
      repo: null,
      prompt: "Compare the two APIs",
    });
  });
});

describe("the running sessions a new session without its own worktree would share a folder with", () => {
  const exited: Session["run"] = {
    kind: "exited",
    runId: "r",
    startedAt: "2026-10-27T10:00:00Z",
    endedAt: "2026-10-27T10:05:00Z",
    exitCode: 0,
    signal: null,
    stoppedByUser: true,
    lastLines: [],
  };
  const sessions = [
    session("main", {}),
    session("ended", { run: exited }),
    session("task", { task: "t1" }),
    session("other-repo", { repo: "billing" }),
    session("free", { repo: null }),
    session("supervisor", { repo: null, supervisor: true }),
  ];

  test("in a repo: the running sessions in its root, not its tasks, ended sessions or other repos", () => {
    expect(sessionsInSameFolder(sessions, "shop").map((s) => s.id)).toEqual(["main"]);
  });

  test("in the projects folder: the running free sessions, not the supervisor", () => {
    expect(sessionsInSameFolder(sessions, null).map((s) => s.id)).toEqual(["free"]);
  });
});
