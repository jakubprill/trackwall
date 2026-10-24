import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import { nextWaiting, nextWaitingShortcut, sessionStateLabel, waitingCount } from "../src/lib/session-state.ts";

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

describe("skok do sesji czekającej", () => {
  const list = [
    session("a", change("Working")),
    waiting("b", change("Input")),
    waiting("c", change("Approval")),
    session("d", change("Working")),
  ];

  test("następna czekająca po bieżącej, w kółko", () => {
    expect(nextWaiting(list, "a")?.id).toBe("b");
    expect(nextWaiting(list, "b")?.id).toBe("c");
    expect(nextWaiting(list, "c")?.id).toBe("b");
    expect(nextWaiting(list, undefined)?.id).toBe("b");
  });

  test("liczą się tylko sesje, które czekają na Ciebie", () => {
    const ended = [session("a", change("Input"), exited(0))];
    expect(nextWaiting(ended, undefined)).toBeUndefined();
    expect(waitingCount(ended)).toBe(0);
    expect(waitingCount(list)).toBe(2);
  });
});

describe("Alt+J", () => {
  test("opens the next waiting session after the selected one", () => {
    const list = [waiting("a", change("Input")), session("b", change("Working")), waiting("c", change("Approval"))];
    expect(nextWaitingShortcut(list, "a", true).open?.id).toBe("c");
    expect(nextWaitingShortcut(list, undefined, false).open?.id).toBe("a");
  });

  test("in Sessions takes the key also when nothing is waiting, elsewhere leaves it for a text field", () => {
    const list = [session("b", change("Working"))];
    expect(nextWaitingShortcut(list, "b", true)).toEqual({ open: undefined, taken: true });
    expect(nextWaitingShortcut(list, undefined, false)).toEqual({ open: undefined, taken: false });
  });
});
