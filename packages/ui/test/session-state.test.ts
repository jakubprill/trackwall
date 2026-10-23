import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import { nextWaiting, sessionStateLabel, waitingCount } from "../src/lib/session-state.ts";

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
    expect(sessionStateLabel(waiting("a", change("Input")))).toEqual({ tone: "warning", label: "czeka na Ciebie" });
    expect(sessionStateLabel(waiting("a", change("Approval")))).toEqual({ tone: "warning", label: "prosi o zgodę" });
    expect(sessionStateLabel(session("a", change("Working")))).toEqual({ tone: "ok", label: "pracuje" });
  });

  test("słabszy sygnał jest podany jako „prawdopodobnie”", () => {
    expect(sessionStateLabel(waiting("a", change("Input", "low"))).label).toBe("prawdopodobnie czeka na Ciebie");
    expect(sessionStateLabel(session("a", change("Working", "medium"))).label).toBe("prawdopodobnie pracuje");
  });

  test("bez sygnału stan jest nieznany; koniec procesu wygrywa ze stanem z hooków", () => {
    expect(sessionStateLabel(session("a", null))).toEqual({ label: "stan nieznany" });
    expect(sessionStateLabel(session("a", change("Input"), exited(null, true)))).toEqual({ label: "zatrzymana" });
    expect(sessionStateLabel(session("a", change("Done"), exited(1)))).toEqual({ label: "zakończona" });
    expect(sessionStateLabel(session("a", change("Input"), exited(1)))).toEqual({ tone: "error", label: "błąd" });
    expect(sessionStateLabel(session("a", change("Error"), exited(0)))).toEqual({ tone: "error", label: "błąd" });
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
