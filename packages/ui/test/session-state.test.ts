import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import { entryId, nextWaiting, nextWaitingShortcut, type SessionEntry } from "../src/lib/session-entries.ts";
import { sessionStateLabel } from "../src/lib/session-state.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-23T10:00:00Z", pid: 10 } as const;

/** `needsAttention` liczy daemon; tu jest podane wprost, tak jak przychodzi w liście sesji. */
function session(id: string, state: Session["state"], run: Session["run"] = running, needsAttention = false): Session {
  return { id, repo: `repo-${id}`, startedAt: "2026-10-23T10:00:00Z", run, state, windowTitle: null, needsAttention, task: null };
}

function waiting(id: string, state: Session["state"]): Session {
  return session(id, state, running, true);
}

function change(state: NonNullable<Session["state"]>["state"], confidence: NonNullable<Session["state"]>["confidence"] = "high") {
  return { state, source: "hook", confidence, at: "2026-10-23T10:01:00Z", reason: "hook" } as const;
}

function exited(exitCode: number | null, stoppedByUser = false): Session["run"] {
  return { kind: "exited", runId: "r", startedAt: "", endedAt: "", exitCode, signal: null, stoppedByUser, lastLines: [] };
}

describe("stan sesji w jednej linii", () => {
  test("sesja, która czeka na Ciebie, ma ton ostrzeżenia, pracująca ok", () => {
    expect(sessionStateLabel(waiting("a", change("Input")))).toEqual({ tone: "warning", label: "waiting for you" });
    expect(sessionStateLabel(waiting("a", change("Approval")))).toEqual({ tone: "warning", label: "asking for approval" });
    expect(sessionStateLabel(session("a", change("Working")))).toEqual({ tone: "ok", label: "working" });
  });

  test("Input the user has already seen is shown as idle, without a warning", () => {
    expect(sessionStateLabel(session("a", change("Input")))).toEqual({ label: "idle" });
    expect(sessionStateLabel(session("a", change("Input", "medium")))).toEqual({ label: "probably idle" });
  });

  test("słabszy sygnał jest podany jako „prawdopodobnie”", () => {
    expect(sessionStateLabel(waiting("a", change("Input", "low"))).label).toBe("probably waiting for you");
    expect(sessionStateLabel(session("a", change("Working", "medium"))).label).toBe("probably working");
  });

  test("bez sygnału stan jest nieznany; koniec procesu wygrywa ze stanem z hooków", () => {
    expect(sessionStateLabel(session("a", null))).toEqual({ label: "state unknown" });
    expect(sessionStateLabel(session("a", change("Input"), exited(null, true)))).toEqual({ label: "stopped" });
    expect(sessionStateLabel(session("a", change("Done"), exited(1)))).toEqual({ label: "finished" });
    expect(sessionStateLabel(session("a", change("Input"), exited(1)))).toEqual({ tone: "error", label: "error" });
    expect(sessionStateLabel(session("a", change("Error"), exited(0)))).toEqual({ tone: "error", label: "error" });
  });
});

/** Session entries of the list, in this order. */
const entries = (...sessions: Session[]): SessionEntry[] => sessions.map((session) => ({ kind: "session", session }));

const proposals: SessionEntry = {
  kind: "proposals",
  proposer: null,
  proposals: [{ id: "p1", repo: "billing", title: "Add refunds", prompt: "add refunds", proposedBy: { session: null }, createdAt: "" }],
};

describe("skok do sesji czekającej", () => {
  const list = entries(
    session("a", change("Working")),
    waiting("b", change("Input")),
    waiting("c", change("Approval")),
    session("d", change("Working")),
  );
  const at = (id: string) => list.find((e) => entryId(e) === id);

  test("następna czekająca po bieżącej, w kółko", () => {
    expect(entryIdOf(nextWaiting(list, at("a")))).toBe("b");
    expect(entryIdOf(nextWaiting(list, at("b")))).toBe("c");
    expect(entryIdOf(nextWaiting(list, at("c")))).toBe("b");
    expect(entryIdOf(nextWaiting(list, undefined))).toBe("b");
  });

  test("liczą się tylko sesje, które czekają na Ciebie", () => {
    expect(nextWaiting(entries(session("a", change("Input"), exited(0))), undefined)).toBeUndefined();
  });

  test("task proposals wait for you too, in list order", () => {
    const withProposals = [proposals, ...list];
    expect(entryIdOf(nextWaiting(withProposals, undefined))).toBe("proposals:outside");
    expect(entryIdOf(nextWaiting(withProposals, at("c")))).toBe("proposals:outside");
  });
});

describe("Alt+J", () => {
  test("opens the next waiting entry after the selected one", () => {
    const list = entries(waiting("a", change("Input")), session("b", change("Working")), waiting("c", change("Approval")));
    expect(entryIdOf(nextWaitingShortcut(list, list[0], true).open)).toBe("c");
    expect(entryIdOf(nextWaitingShortcut(list, undefined, false).open)).toBe("a");
  });

  test("opens task proposals, also outside Sessions", () => {
    expect(nextWaitingShortcut([proposals], undefined, false)).toEqual({ open: proposals, taken: true });
  });

  test("in Sessions takes the key also when nothing is waiting, elsewhere leaves it for a text field", () => {
    const list = entries(session("b", change("Working")));
    expect(nextWaitingShortcut(list, list[0], true)).toEqual({ open: undefined, taken: true });
    expect(nextWaitingShortcut(list, undefined, false)).toEqual({ open: undefined, taken: false });
  });
});

function entryIdOf(entry: SessionEntry | undefined): string | undefined {
  return entry && entryId(entry);
}
