import { describe, expect, test } from "bun:test";
import type { Session, SessionList } from "@trackwall/protocol";
import { currentSessionProfile, environmentStripTitle, profileChange, sessionsOnOtherProfile } from "../src/lib/session-profile.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-11-02T08:00:00Z", pid: 10 } as const;
const exited: Session["run"] = {
  kind: "exited",
  runId: "r",
  startedAt: "2026-11-02T08:00:00Z",
  endedAt: "2026-11-02T08:30:00Z",
  exitCode: 0,
  signal: null,
  stoppedByUser: true,
  lastLines: [],
};

function session(id: string, profile: string | null, run: Session["run"] = running): Session {
  return {
    id,
    repo: "shop",
    supervisor: false,
    startedAt: "2026-11-02T08:00:00Z",
    run,
    state: null,
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile, problem: null },
    view: "terminal",
    readRequest: null,
    copyRequest: null,
    usage: null,
    model: null,
  };
}

function list(sessions: Session[], sessionProfile: SessionList["sessionProfile"]): SessionList {
  return { sessions, tasks: [], proposals: [], messages: [], lastSupervisor: null, sessionProfile };
}

describe("a running session that started with another session profile than sessions get now (ADR-178)", () => {
  test("says which profile it started with and which one sessions start with now", () => {
    expect(profileChange(session("s1", null), { name: "byok" })).toBe("Started with no profile; sessions now start with profile byok");
    expect(profileChange(session("s1", "byok"), { name: null })).toBe("Started with profile byok; sessions now start with no profile");
    expect(profileChange(session("s1", "byok"), { name: "work" })).toBe("Started with profile byok; sessions now start with profile work");
  });

  test("says nothing while the session runs with the current profile", () => {
    expect(profileChange(session("s1", "byok"), { name: "byok" })).toBeNull();
    expect(profileChange(session("s1", null), { name: null })).toBeNull();
  });

  test("says nothing for an ended session, whose next start takes the current profile", () => {
    expect(profileChange(session("s1", null, exited), { name: "byok" })).toBeNull();
  });

  test("says nothing while the current profile is not known: workspace.yaml cannot be read or the list has not come", () => {
    expect(profileChange(session("s1", null), null)).toBeNull();
    expect(currentSessionProfile(undefined)).toBeNull();
    expect(currentSessionProfile(list([], { name: "byok" }))).toEqual({ name: "byok" });
  });

  test("Settings counts the running sessions that keep another profile", () => {
    const sessions = [session("old", null), session("new", "byok"), session("ended", null, exited)];
    expect(sessionsOnOtherProfile(list(sessions, { name: "byok" })).map((s) => s.id)).toEqual(["old"]);
    expect(sessionsOnOtherProfile(list(sessions, null))).toEqual([]);
  });
});

describe("the headline of a session panel's environment strip (ADR-119, ADR-178)", () => {
  test("names the mise variables when they changed, also with the profile, and the profile when only it changed", () => {
    expect(environmentStripTitle(true, null)).toBe("The environment from mise changed since the session started");
    expect(environmentStripTitle(true, "Started with no profile; sessions now start with profile byok")).toBe(
      "The environment from mise changed since the session started",
    );
    expect(environmentStripTitle(false, "Started with no profile; sessions now start with profile byok")).toBe(
      "The session profile changed since the session started",
    );
  });
});
