import { describe, expect, test } from "bun:test";
import type { Session, SessionList } from "@trackwall/protocol";
import { sessionRows } from "../src/lib/session-entries.ts";
import { sessionLinkKnown, unknownLinkMessage } from "../src/lib/session-link.ts";

const KNOWN = "0b4c1d2e-0000-4000-8000-000000000001";
const SUPERVISOR = "0b4c1d2e-0000-4000-8000-000000000002";
const UNKNOWN = "0b4c1d2e-0000-4000-8000-0000000000ff";

function session(id: string, supervisor = false): Session {
  return {
    id,
    repo: supervisor ? null : "shop",
    supervisor,
    startedAt: "2026-11-13T07:00:00.000Z",
    run: { kind: "running", runId: id, startedAt: "2026-11-13T07:00:00.000Z", pid: 1 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    readRequest: null,
    copyRequest: null,
    usage: null,
    model: null,
    modelInUse: null,
    modelError: null,
    tokenBudget: null,
  };
}

const list: SessionList = {
  sessions: [session(KNOWN), session(SUPERVISOR, true)],
  tasks: [],
  proposals: [],
  messages: [],
  lastSupervisor: null,
  sessionProfile: null,
};
const entries = sessionRows(list).map((r) => r.entry);

describe("a trackwall:// link to a session or task", () => {
  test("is known when the list holds its session, also the supervisor's, whose panel opens instead of an entry", () => {
    expect(sessionLinkKnown(list, entries, { kind: "session", id: KNOWN })).toBe(true);
    expect(sessionLinkKnown(list, entries, { kind: "session", id: SUPERVISOR })).toBe(true);
  });

  test("is unknown for an id the list lacks and before the list has loaded, so it opens no other entry", () => {
    expect(sessionLinkKnown(list, entries, { kind: "session", id: UNKNOWN })).toBe(false);
    expect(sessionLinkKnown(list, entries, { kind: "task", id: UNKNOWN })).toBe(false);
    expect(sessionLinkKnown(undefined, [], { kind: "session", id: KNOWN })).toBe(false);
  });

  test("an unknown target's message names it and the likely reasons", () => {
    expect(unknownLinkMessage({ kind: "session", id: UNKNOWN })).toBe(
      `The link points to a session this Trackwall does not have (${UNKNOWN}). ` +
        "It may have ended, or the link comes from Trackwall running somewhere else, such as in a dev container.",
    );
  });
});
