import { describe, expect, test } from "bun:test";
import type { ReproductionCheck, TaskEvidence, Verification } from "@trackwall/protocol";
import { evidenceRows, taskEvidencePollMs } from "../src/lib/task-evidence.ts";

const reproTest = { file: "src/test/java/shop/CartTest.java", name: "CartTest#sums", failure: "expected: <3> but was: <4>" };

const check = (fields: Partial<ReproductionCheck> = {}): ReproductionCheck => ({
  task: "t1",
  repo: "shop",
  test: reproTest,
  filter: "CartTest",
  state: "reproduced",
  phase: null,
  startedAt: "2026-11-18T10:00:00Z",
  finishedAt: "2026-11-18T10:02:00Z",
  base: null,
  change: null,
  message: null,
  ...fields,
});

const verification = (fields: Partial<Verification> = {}): Verification => ({
  task: "t1",
  repo: "shop",
  miseTask: "test",
  state: "passed",
  runId: "r1",
  startedAt: "2026-11-18T10:05:00Z",
  finishedAt: "2026-11-18T10:06:00Z",
  exitCode: 0,
  message: null,
  tests: {
    totals: { tests: 128, failures: 0, errors: 0, skipped: 3, timeSeconds: 12 },
    reports: 4,
    unreadReports: 0,
    earlierReports: 0,
    truncated: false,
  },
  failures: [],
  errors: [],
  lastLines: [],
  outdated: false,
  ...fields,
});

const evidence = (fields: Partial<TaskEvidence> = {}): TaskEvidence => ({
  task: "t1",
  planApproved: false,
  reproduction: null,
  verification: null,
  rules: null,
  usage: null,
  models: [],
  ...fields,
});

const row = (e: TaskEvidence, key: string) => evidenceRows(e).find((r) => r.key === key);

describe("the evidence card of a task", () => {
  test("a task Trackwall knows nothing about shows every gap, none of them green and none with a source", () => {
    expect(evidenceRows(evidence())).toEqual([
      { key: "plan", label: "Plan", text: "none approved: the task did not start with Plan first", source: null },
      { key: "reproduction", label: "Reproduction test", text: "none named by the agent", source: null },
      { key: "verification", label: "Verification", text: "not run yet", source: null },
      { key: "rules", label: "Rules check", text: "not run yet", source: null },
      { key: "models", label: "Model", text: "not known yet", source: null },
    ]);
  });

  test("a change with every check behind it is green, each fact with whose word it is", () => {
    const rows = evidenceRows(
      evidence({
        planApproved: true,
        reproduction: { test: reproTest, check: check(), outdated: false },
        verification: verification(),
        rules: {
          review: {
            task: "t1",
            repo: "shop",
            kind: "rules",
            state: "done",
            trigger: "user",
            startedAt: "2026-11-18T10:10:00Z",
            finishedAt: "2026-11-18T10:11:00Z",
            diffHash: "0".repeat(64),
            diffTruncated: false,
            findings: [],
            text: "",
            message: null,
            ruleFiles: ["AGENTS.md", "docs/adr/0007-money.md"],
          },
          outdated: false,
        },
        usage: {
          modelCalls: 42,
          inputTokens: 1_150_000,
          outputTokens: 50_000,
          aiCredits: 3.4,
          aiCreditsPartial: false,
          premiumRequests: 0,
        },
        models: [{ model: "claude-sonnet-4.5", modelCalls: 40 }],
      }),
    );

    expect(rows.map(({ label, tone, text, source }) => [label, tone, text, source])).toEqual([
      ["Plan", "ok", "you approved the agent's plan before it changed files", "approval"],
      ["Reproduction test", "ok", "CartTest#sums fails without the fix and passes with it", "check"],
      ["Verification", "ok", "passed (mise task test · 128 tests · 3 skipped)", "check"],
      ["Rules check", "ok", "no findings against 2 rule files", "check"],
      ["Model", undefined, "claude-sonnet-4.5 (40 calls) · 3.4 AI credits, 1.2M tokens", "observed"],
    ]);
  });

  test("a reproduction test nobody checked is the agent's word, not a green row", () => {
    expect(row(evidence({ reproduction: { test: reproTest, check: null, outdated: false } }), "reproduction")).toEqual({
      key: "reproduction",
      label: "Reproduction test",
      tone: "warning",
      text: "CartTest#sums: the agent says it failed before the fix, not checked by Trackwall",
      source: "claim",
    });
  });

  test("a check that did not reproduce the error speaks against the change, with its reason", () => {
    const failed = check({ state: "not_reproduced", message: "the test still fails with the change" });
    expect(row(evidence({ reproduction: { test: reproTest, check: failed, outdated: false } }), "reproduction")).toMatchObject({
      tone: "error",
      text: "CartTest#sums not reproduced (the test still fails with the change)",
    });
  });

  test("a check or a verification from before the changes moved on loses its green and says so", () => {
    const outdated = evidence({
      reproduction: { test: reproTest, check: check(), outdated: true },
      verification: verification({ outdated: true }),
    });

    expect(row(outdated, "reproduction")).toMatchObject({
      tone: "warning",
      text: "CartTest#sums failed without the fix and passed with it on an earlier version of the changes",
    });
    expect(row(outdated, "verification")).toMatchObject({
      tone: "warning",
      text: "passed on an earlier version of the changes (mise task test · 128 tests · 3 skipped)",
    });
  });

  test("a failed verification is red", () => {
    const failed = verification({
      state: "failed",
      exitCode: 1,
      tests: {
        totals: { tests: 3, failures: 1, errors: 0, skipped: 0, timeSeconds: 1 },
        reports: 1,
        unreadReports: 0,
        earlierReports: 0,
        truncated: false,
      },
    });
    expect(row(evidence({ verification: failed }), "verification")).toMatchObject({
      tone: "error",
      text: "failed (mise task test · 3 tests · 1 failed)",
    });
  });

  test("is read again soon while a check or a verification runs, and seldom otherwise", () => {
    expect(taskEvidencePollMs(evidence({ verification: verification({ state: "running" }) }))).toBe(2000);
    expect(taskEvidencePollMs(evidence({ reproduction: { test: reproTest, check: check({ state: "running" }), outdated: false } }))).toBe(
      2000,
    );
    expect(taskEvidencePollMs(evidence())).toBe(10_000);
    expect(taskEvidencePollMs(undefined)).toBe(10_000);
  });
});
