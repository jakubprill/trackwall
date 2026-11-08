import { describe, expect, test } from "bun:test";
import type { ViewerSession } from "@trackwall/protocol";
import { sessionGroups, statusBarState } from "../src/session-groups.ts";

function session(over: Partial<ViewerSession>): ViewerSession {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    place: "shop",
    supervisor: false,
    windowTitle: null,
    task: null,
    taskName: null,
    status: { tone: "ok", label: "working" },
    needsAttention: false,
    live: true,
    since: "2026-11-07T10:00:00Z",
    ...over,
  };
}

const approval = session({
  id: "22222222-2222-4222-8222-222222222222",
  taskName: "Fix the checkout total",
  status: { tone: "warning", label: "asking for approval" },
  needsAttention: true,
});
const working = session({ windowTitle: "Editing Cart.java" });
const ended = session({
  id: "33333333-3333-4333-8333-333333333333",
  place: "Supervisor",
  status: { tone: null, label: "stopped" },
  live: false,
});

describe("the side bar", () => {
  test("groups the sessions by what they need from you, waiting first, each named by its task, window title or place", () => {
    expect(sessionGroups({ sessions: [working, ended, approval], proposals: 0 })).toEqual([
      {
        id: "waiting",
        label: "Waiting for you",
        rows: [
          { id: approval.id, label: "Fix the checkout total", description: "shop · asking for approval", tone: "warning", live: true },
        ],
      },
      {
        id: "running",
        label: "Running",
        rows: [{ id: working.id, label: "Editing Cart.java", description: "shop · working", tone: "ok", live: true }],
      },
      {
        id: "ended",
        label: "Ended",
        rows: [{ id: ended.id, label: "Supervisor", description: "Supervisor · stopped", tone: null, live: false }],
      },
    ]);
  });

  test("leaves out groups without sessions", () => {
    expect(sessionGroups({ sessions: [working], proposals: 0 }).map((g) => g.id)).toEqual(["running"]);
  });
});

describe("the status bar", () => {
  test("counts the sessions and task proposals waiting for you, in the warning colours", () => {
    expect(statusBarState({ kind: "connected", list: { sessions: [approval, working], proposals: 2 } })).toEqual({
      text: "$(bell) 3 waiting",
      tooltip: "Trackwall: 1 session and 2 task proposals waiting for you",
      warning: true,
    });
  });

  test("with nothing waiting, counts the running sessions", () => {
    expect(statusBarState({ kind: "connected", list: { sessions: [working, ended], proposals: 0 } })).toEqual({
      text: "$(pulse) 1 running",
      tooltip: "Trackwall: 1 session running, none waiting for you",
      warning: false,
    });
  });

  test("hides itself while viewer access is off, and says why Trackwall is unavailable", () => {
    expect(statusBarState({ kind: "off" })).toBeUndefined();
    expect(statusBarState({ kind: "unavailable", reason: "missing or invalid token" })).toEqual({
      text: "$(debug-disconnect) Trackwall",
      tooltip: "Trackwall: missing or invalid token",
      warning: false,
    });
  });
});
