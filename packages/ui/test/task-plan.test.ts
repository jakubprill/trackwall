import { describe, expect, test } from "bun:test";
import type { Session, TaskState } from "@trackwall/protocol";
import { planFirstOffer, planFirstToSend, planStep } from "../src/lib/task-plan.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-11-08T08:00:00Z", pid: 10 } as const;
const exited: Session["run"] = {
  kind: "exited",
  runId: "r",
  startedAt: "2026-11-08T08:00:00Z",
  endedAt: "2026-11-08T08:05:00Z",
  exitCode: 0,
  signal: null,
  stoppedByUser: true,
  lastLines: [],
};

function session(state: TaskState | null, run: Session["run"] = running): Session {
  return {
    id: "s1",
    repo: "shop",
    supervisor: false,
    startedAt: "2026-11-08T08:00:00Z",
    run,
    state: state && { state, source: "acp", confidence: "exact", at: "2026-11-08T08:01:00Z", reason: "acp" },
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task: "t1",
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "conversation",
    readRequest: null,
    copyRequest: null,
    usage: null,
    model: null,
    modelInUse: null,
    tokenBudget: null,
  };
}

describe("the plan of a task that plans first (ADR-229)", () => {
  test("is being written while the session starts or the agent's turn runs, also while it asks for an approval", () => {
    expect(planStep({ plan: "planning" }, session(null))).toBe("writing");
    expect(planStep({ plan: "planning" }, session("Working"))).toBe("writing");
    expect(planStep({ plan: "planning" }, session("Approval"))).toBe("writing");
  });

  test("is ready for approval once the turn ended, also a turn that failed", () => {
    expect(planStep({ plan: "planning" }, session("Input"))).toBe("ready");
    expect(planStep({ plan: "planning" }, session("Error"))).toBe("ready");
  });

  test("needs a resume when no session runs", () => {
    expect(planStep({ plan: "planning" }, undefined)).toBe("resume");
    expect(planStep({ plan: "planning" }, session("Done", exited))).toBe("resume");
  });

  test("shows nothing for a task without a plan or with an approved one", () => {
    expect(planStep({ plan: null }, session("Input"))).toBeNull();
    expect(planStep({ plan: "approved" }, session("Input"))).toBeNull();
  });
});

describe("Plan first on the New session form (ADR-229)", () => {
  test("is offered for a task in the conversation view and goes with it when chosen", () => {
    const offer = planFirstOffer({ kind: "task" }, "conversation");

    expect(offer).toEqual({ unavailable: null });
    expect(planFirstToSend(offer, true)).toBe(true);
    expect(planFirstToSend(offer, false)).toBe(false);
  });

  test("stays visible but off for a task in a terminal, with why, and a choice made before does not go", () => {
    const offer = planFirstOffer({ kind: "task" }, "terminal");

    expect(offer?.unavailable).toContain("needs Chat (preview)");
    expect(planFirstToSend(offer, true)).toBe(false);
  });

  test("is offered while the task still needs its prompt, so the pill does not wait for the first word", () => {
    expect(planFirstOffer({ kind: "needs-prompt" }, "conversation")).toEqual({ unavailable: null });
  });

  test("is not offered for a session or a change", () => {
    expect(planFirstOffer({ kind: "session" }, "conversation")).toBeNull();
    expect(planFirstOffer({ kind: "change" }, "conversation")).toBeNull();
    expect(planFirstOffer({ kind: "needs-title" }, "conversation")).toBeNull();
    expect(planFirstToSend(null, true)).toBe(false);
  });
});
