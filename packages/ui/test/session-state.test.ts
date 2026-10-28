import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import {
  entryId,
  nextWaiting,
  nextWaitingShortcut,
  nextWaitingTarget,
  type SessionEntry,
  SUPERVISOR_TARGET,
  type WaitingTarget,
} from "../src/lib/session-entries.ts";
import { agentsInTurn, closeCutsOffTurn, sessionPlace, sessionStateLabel } from "../src/lib/session-state.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-23T10:00:00Z", pid: 10 } as const;

/** The daemon computes `needsAttention`; here it is given directly, as it comes in the session list. */
function session(id: string, state: Session["state"], run: Session["run"] = running, needsAttention = false): Session {
  return {
    id,
    repo: `repo-${id}`,
    supervisor: false,
    startedAt: "2026-10-23T10:00:00Z",
    run,
    state,
    windowTitle: null,
    needsAttention,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], problem: null },
    view: "terminal",
  };
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

describe("session state in one line", () => {
  test("a session waiting for you has a warning tone, a working one ok", () => {
    expect(sessionStateLabel(waiting("a", change("Input")))).toEqual({ tone: "warning", label: "waiting for you" });
    expect(sessionStateLabel(waiting("a", change("Approval")))).toEqual({ tone: "warning", label: "asking for approval" });
    expect(sessionStateLabel(session("a", change("Working")))).toEqual({ tone: "ok", label: "working" });
  });

  test("Input the user has already seen is shown as idle, without a warning", () => {
    expect(sessionStateLabel(session("a", change("Input")))).toEqual({ label: "idle" });
    expect(sessionStateLabel(session("a", change("Input", "medium")))).toEqual({ label: "probably idle" });
  });

  test("a weaker signal is given as “probably”", () => {
    expect(sessionStateLabel(waiting("a", change("Input", "low"))).label).toBe("probably waiting for you");
    expect(sessionStateLabel(session("a", change("Working", "medium"))).label).toBe("probably working");
  });

  test("without a signal the state is unknown; the process exit wins over the state from hooks", () => {
    expect(sessionStateLabel(session("a", null))).toEqual({ label: "state unknown" });
    expect(sessionStateLabel(session("a", change("Input"), exited(null, true)))).toEqual({ label: "stopped" });
    expect(sessionStateLabel(session("a", change("Done"), exited(1)))).toEqual({ label: "finished" });
    expect(sessionStateLabel(session("a", change("Input"), exited(1)))).toEqual({ tone: "error", label: "error" });
    expect(sessionStateLabel(session("a", change("Error"), exited(0)))).toEqual({ tone: "error", label: "error" });
  });
});

describe("where a session works", () => {
  test("a repo, or for a session in the projects folder the supervisor or a free session (ADR-100)", () => {
    expect(sessionPlace({ repo: "shop", supervisor: false })).toBe("shop");
    expect(sessionPlace({ repo: null, supervisor: true })).toBe("Supervisor");
    expect(sessionPlace({ repo: null, supervisor: false })).toBe("Free session");
  });
});

describe("closing a session", () => {
  test("asks first while the agent is working or asking for approval of a step or a plan", () => {
    expect(closeCutsOffTurn(session("a", change("Working")))).toBe(true);
    expect(closeCutsOffTurn(waiting("a", change("Approval")))).toBe(true);
    expect(closeCutsOffTurn(waiting("a", change("Plan")))).toBe(true);
  });

  test("closes at once when the agent waits for a prompt, is idle or in an unknown state", () => {
    expect(closeCutsOffTurn(waiting("a", change("Input")))).toBe(false);
    expect(closeCutsOffTurn(session("a", change("Input")))).toBe(false);
    expect(closeCutsOffTurn(session("a", change("Stale")))).toBe(false);
    expect(closeCutsOffTurn(session("a", null))).toBe(false);
  });

  test("closes at once when the session is already stopping or has ended", () => {
    expect(closeCutsOffTurn(session("a", change("Working"), { kind: "stopping", runId: "r", startedAt: "", pid: 10 }))).toBe(false);
    expect(closeCutsOffTurn(session("a", change("Working"), exited(1)))).toBe(false);
  });
});

describe("agents in the middle of a turn, which an update waits for (ADR-97)", () => {
  test("counts the running agents that work or ask for approval, not those waiting for a prompt or ended", () => {
    const sessions = [
      session("a", change("Working")),
      waiting("b", change("Approval")),
      waiting("c", change("Input")),
      session("d", null),
      session("e", change("Working"), exited(0)),
    ];

    expect(agentsInTurn(sessions)).toBe(2);
    expect(agentsInTurn([])).toBe(0);
  });
});

/** Session entries of the list, in this order. */
const entries = (...sessions: Session[]): SessionEntry[] => sessions.map((session) => ({ kind: "session", session }));

const proposals: SessionEntry = {
  kind: "proposals",
  proposer: null,
  proposals: [
    {
      id: "p1",
      kind: "task",
      repo: "billing",
      title: "Add refunds",
      prompt: "add refunds",
      proposedBy: { session: null, supervisor: false },
      model: null,
      approvals: "ask",
      createdAt: "",
    },
  ],
};

describe("jump to a waiting session", () => {
  const list = entries(
    session("a", change("Working")),
    waiting("b", change("Input")),
    waiting("c", change("Approval")),
    session("d", change("Working")),
  );
  const at = (id: string) => list.find((e) => entryId(e) === id);

  test("the next waiting one after the current one, round and round", () => {
    expect(entryIdOf(nextWaiting(list, at("a")))).toBe("b");
    expect(entryIdOf(nextWaiting(list, at("b")))).toBe("c");
    expect(entryIdOf(nextWaiting(list, at("c")))).toBe("b");
    expect(entryIdOf(nextWaiting(list, undefined))).toBe("b");
  });

  test("only sessions waiting for you count", () => {
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
    expect(entryIdOf(nextWaitingShortcut(list, list[0], true, false).open)).toBe("c");
    expect(entryIdOf(nextWaitingShortcut(list, undefined, false, false).open)).toBe("a");
  });

  test("opens task proposals, also outside Sessions", () => {
    expect(nextWaitingShortcut([proposals], undefined, false, false)).toEqual({ open: proposals, taken: true });
  });

  test("in Sessions takes the key also when nothing is waiting, elsewhere leaves it for a text field", () => {
    const list = entries(session("b", change("Working")));
    expect(nextWaitingShortcut(list, list[0], true, false)).toEqual({ open: undefined, taken: true });
    expect(nextWaitingShortcut(list, undefined, false, false)).toEqual({ open: undefined, taken: false });
  });

  test("goes to the supervisor once no entry of the list waits, also outside Sessions", () => {
    const list = entries(waiting("a", change("Input")), session("b", change("Working")));
    expect(entryIdOf(nextWaitingTarget(list, undefined, true))).toBe("a");
    expect(nextWaitingTarget(list.slice(1), undefined, true)).toEqual(SUPERVISOR_TARGET);
    expect(nextWaitingShortcut(list.slice(1), undefined, false, true)).toEqual({ open: SUPERVISOR_TARGET, taken: true });
    expect(nextWaitingTarget(list.slice(1), undefined, false)).toBeUndefined();
  });
});

function entryIdOf(entry: WaitingTarget | undefined): string | undefined {
  return entry && entry.kind !== "supervisor" ? entryId(entry) : entry?.kind;
}
