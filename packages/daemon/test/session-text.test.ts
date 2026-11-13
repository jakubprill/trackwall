import { describe, expect, test } from "bun:test";
import type { AgentSession, GetSessionResult, Task, Verification } from "@trackwall/protocol";
import { sessionText } from "../src/mcp/session-text.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

const session: AgentSession = {
  id: SESSION_ID,
  repo: "shop",
  supervisor: false,
  startedAt: "2026-11-05T09:00:00.000Z",
  model: "gpt-5.1",
  modelInUse: "gpt-5.1",
  modelError: null,
  tokenBudget: null,
  run: { kind: "running", runId: "run-1", startedAt: "2026-11-05T09:00:00.000Z", pid: 4242 },
  state: { state: "Input", source: "hook", confidence: "exact", at: "2026-11-05T09:20:00.000Z", reason: "agentStop" },
  windowTitle: null,
  needsAttention: true,
  waitingSince: "2026-11-05T09:20:00.000Z",
  stuck: null,
  task: TASK_ID,
  environment: { variables: ["SHOP_URL", "SHOP_MODE"], secrets: ["SHOP_TOKEN"], agentSecrets: [], profile: null, problem: null },
  view: "terminal",
  readRequest: null,
  usage: { modelCalls: 12, inputTokens: 340_000, outputTokens: 5_100, aiCredits: null, aiCreditsPartial: false, premiumRequests: 1 },
};

const task: Task = {
  id: TASK_ID,
  repo: "shop",
  prompt: "Fix the login form: a wrong password must say so.",
  branch: "trackwall/fix-login-222222",
  baseBranch: "main",
  base: "a".repeat(40),
  worktree: "/home/me/worktrees/shop/fix-login-222222",
  createdAt: "2026-11-05T08:59:00.000Z",
  title: "Fix login",
  proposedBy: { session: null, supervisor: true, task: null },
  model: null,
  approvals: "ask",
  plan: null,
  javaNavigation: false,
  sandbox: false,
  item: null,
  view: "terminal",
  summary: {
    text: "The form now says Wrong password.",
    checkSteps: ["Open /login and type a wrong password: the form says Wrong password"],
    reproTest: null,
    reportedAt: "2026-11-05T09:19:00.000Z",
  },
  inReview: true,
  port: 41001,
  included: { files: [], problems: [] },
  change: null,
  retryOf: null,
};

const failed: Verification = {
  task: TASK_ID,
  repo: "shop",
  miseTask: "test",
  state: "failed",
  runId: "run-7",
  outdated: false,
  startedAt: "2026-11-05T09:21:00.000Z",
  finishedAt: "2026-11-05T09:22:00.000Z",
  exitCode: 1,
  message: "1 test failed",
  tests: {
    totals: { tests: 10, failures: 1, errors: 0, skipped: 2, timeSeconds: 3.5 },
    reports: 3,
    unreadReports: 0,
    earlierReports: 0,
    truncated: false,
  },
  failures: [
    {
      report: "build/test-results/TEST-LoginTest.xml",
      suite: "LoginTest",
      className: null,
      name: "says wrong password",
      kind: "failure",
      type: "AssertionError",
      message: "expected Wrong password",
      lines: ["at LoginTest.java:12"],
      omittedLines: 4,
      timeSeconds: 0.1,
    },
  ],
  errors: [],
  lastLines: ["BUILD FAILED"],
};

describe("get_session text", () => {
  test("gives a task session's state, task, summary, changes and verification on short lines, without the prompt", () => {
    const result: GetSessionResult = {
      session,
      task,
      changes: {
        files: [
          { path: "src/login.ts", change: "modified", additions: 10, deletions: 2 },
          { path: "src/login.test.ts", change: "added", additions: 30, deletions: 0 },
          { path: "logo.png", change: "deleted", additions: null, deletions: null },
        ],
        filesTruncated: false,
        commits: 2,
        uncommitted: 1,
      },
      changesError: null,
      verification: failed,
      javaNavigation: null,
    };

    expect(sessionText(result, false)).toBe(
      [
        `Session ${SESSION_ID} (task ${TASK_ID} in shop) on gpt-5.1: running since 2026-11-05T09:00:00.000Z`,
        "State: Input at 2026-11-05T09:20:00.000Z (hook, exact): agentStop",
        "Needs attention: it waits for the user or for input since 2026-11-05T09:20:00.000Z.",
        "Environment: 2 variables; 1 secret",
        "Usage: 12 model calls, 340000 input and 5100 output tokens",
        `## Task ${TASK_ID}: Fix login`,
        `Branch trackwall/fix-login-222222 from main at aaaaaaaaaaaa, created 2026-11-05T08:59:00.000Z; worktree /home/me/worktrees/shop/fix-login-222222; port 41001`,
        "proposed by the user, handed to the supervisor; model default; approvals ask",
        "Prompt left out (withPrompt: true adds it).",
        "## Summary (reported 2026-11-05T09:19:00.000Z)",
        "The form now says Wrong password.",
        "Check steps:",
        "1. Open /login and type a wrong password: the form says Wrong password",
        "## Changes: 2 commits, 1 uncommitted, 3 files",
        "M src/login.ts +10 -2",
        "A src/login.test.ts +30 -0",
        "D logo.png",
        "## Verification: failed (mise task test, finished 2026-11-05T09:22:00.000Z, exit code 1)",
        "Message: 1 test failed",
        "Tests: 10 tests, 1 failure, 0 errors, 2 skipped; 3 reports",
        "Failed test LoginTest says wrong password (failure AssertionError): expected Wrong password",
        "  at LoginTest.java:12",
        "  (4 more lines)",
        "Last lines:",
        "  BUILD FAILED",
      ].join("\n"),
    );
  });

  test("adds the prompt when asked, and says why the changes are missing and that nothing was reported yet", () => {
    const result: GetSessionResult = {
      session: {
        ...session,
        needsAttention: false,
        usage: null,
        environment: { ...session.environment, variables: [], secrets: [] },
      },
      task: { ...task, summary: null },
      changes: null,
      changesError: "not_found: the worktree of task fix-login is gone",
      verification: null,
      javaNavigation: { kind: "importing", since: "2026-11-05T09:01:00.000Z" },
    };

    expect(sessionText(result, true)).toBe(
      [
        `Session ${SESSION_ID} (task ${TASK_ID} in shop) on gpt-5.1: running since 2026-11-05T09:00:00.000Z`,
        "State: Input at 2026-11-05T09:20:00.000Z (hook, exact): agentStop",
        `## Task ${TASK_ID}: Fix login`,
        `Branch trackwall/fix-login-222222 from main at aaaaaaaaaaaa, created 2026-11-05T08:59:00.000Z; worktree /home/me/worktrees/shop/fix-login-222222; port 41001`,
        "proposed by the user, handed to the supervisor; model default; approvals ask",
        "Prompt:",
        "Fix the login form: a wrong password must say so.",
        "## Summary: not reported yet",
        "## Changes unknown: not_found: the worktree of task fix-login is gone",
        "Java navigation: importing since 2026-11-05T09:01:00.000Z",
      ].join("\n"),
    );
  });

  test("gives a supervisor or a repo-root session alone, and an exit with its code", () => {
    const supervisor: GetSessionResult = {
      session: {
        ...session,
        repo: null,
        supervisor: true,
        model: null,
        task: null,
        state: null,
        needsAttention: false,
        usage: null,
        environment: { variables: [], secrets: [], agentSecrets: [], profile: "work", problem: null },
        run: {
          kind: "exited",
          runId: "run-1",
          startedAt: "2026-11-05T09:00:00.000Z",
          endedAt: "2026-11-05T10:00:00.000Z",
          exitCode: 0,
          signal: null,
          stoppedByUser: true,
        },
      },
      task: null,
      changes: null,
      changesError: null,
      verification: null,
      javaNavigation: null,
    };

    expect(sessionText(supervisor, false)).toBe(
      [
        `Session ${SESSION_ID} (supervisor): exited at 2026-11-05T10:00:00.000Z (exit code 0, stopped by the user)`,
        "Environment: profile work",
      ].join("\n"),
    );
  });

  test("names the model Copilot CLI took when it is not the one the session was started on (ADR-225)", () => {
    const result: GetSessionResult = {
      session: { ...session, model: "claude-sonnet-5.5", modelInUse: "gpt-6-luna", task: null, usage: null, needsAttention: false },
      task: null,
      changes: null,
      changesError: null,
      verification: null,
      javaNavigation: null,
    };

    expect(sessionText(result, false).split("\n")[0]).toBe(
      `Session ${SESSION_ID} (shop) on gpt-6-luna instead of claude-sonnet-5.5: running since 2026-11-05T09:00:00.000Z`,
    );
  });

  test("says why the session's last model call failed, so the supervisor does not resume it on the same model (ADR-242)", () => {
    const failed = 'Execution failed: Model "gpt-9" is not available.';
    const result: GetSessionResult = {
      session: { ...session, model: "gpt-9", modelInUse: "gpt-9", modelError: failed, task: null, usage: null, needsAttention: false },
      task: null,
      changes: null,
      changesError: null,
      verification: null,
      javaNavigation: null,
    };

    expect(sessionText(result, false).split("\n")).toContain(`Its last model call failed: ${failed}`);
  });

  test("says when Trackwall stopped a task's session at its token budget, so the supervisor does not resume it (ADR-237)", () => {
    const result: GetSessionResult = {
      session: { ...session, usage: null, needsAttention: false, tokenBudget: { budget: 2_000_000, used: 2_010_000, reached: true } },
      task: null,
      changes: null,
      changesError: null,
      verification: null,
      javaNavigation: null,
    };

    expect(sessionText(result, false).split("\n")).toContain(
      "Token budget: 2010000 of 2000000 tokens used since this start; Trackwall stopped the session at it, and only the user's Resume gives the task the budget again.",
    );
  });
});
