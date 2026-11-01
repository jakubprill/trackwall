import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import { environmentChangeParts, restartButton } from "../src/lib/environment-change.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-29T08:00:00Z", pid: 10 } as const;

function session(state: "Working" | "Input" | null, run: Session["run"] = running): Session {
  return {
    id: "s1",
    repo: "shop",
    supervisor: false,
    startedAt: "2026-10-29T08:00:00Z",
    run,
    state: state && { state, source: "hook", confidence: "high", at: "2026-10-29T08:01:00Z", reason: "hook" },
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: ["GITLAB_TOKEN"], secrets: ["GITLAB_TOKEN"], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
  };
}

describe("a running session whose environment from mise changed (ADR-119)", () => {
  test("names each kind of change with its variables", () => {
    expect(
      environmentChangeParts({
        added: ["JIRA_TOKEN", "DEV_FLAG"],
        removed: ["OLD_FLAG"],
        changed: ["GITLAB_TOKEN"],
        shared: ["JIRA_TOKEN"],
        unshared: ["DEPLOY_KEY"],
      }),
    ).toEqual([
      "new: JIRA_TOKEN, DEV_FLAG",
      "changed: GITLAB_TOKEN",
      "removed: OLD_FLAG",
      "now for the agent's tools: JIRA_TOKEN",
      "no longer for the agent's tools: DEPLOY_KEY",
    ]);
  });

  test("leaves out the kinds without a change", () => {
    expect(environmentChangeParts({ added: [], removed: [], changed: ["GITLAB_TOKEN"], shared: [], unshared: [] })).toEqual([
      "changed: GITLAB_TOKEN",
    ]);
  });

  test("the restart waits while the agent is in the middle of a turn", () => {
    expect(restartButton(session("Working"), false)).toMatchObject({ disabled: true, title: expect.stringContaining("middle of a turn") });
  });

  test("the restart is offered while the agent waits for you, and not while one runs or once the session stopped", () => {
    expect(restartButton(session("Input"), false).disabled).toBe(false);
    expect(restartButton(session("Input"), true).disabled).toBe(true);
    expect(restartButton(session("Input", { ...running, kind: "stopping" }), false).disabled).toBe(true);
    expect(restartButton(undefined, false).disabled).toBe(true);
  });
});
