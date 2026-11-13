import { describe, expect, test } from "bun:test";
import type { AutoReview, MergeRequestEvidence, ReproductionCheck, Task, Verification } from "@trackwall/protocol";
import { mergeRequestDraft } from "../src/lib/merge-request.ts";
import { evidenceLines } from "../src/lib/merge-request-evidence.ts";

const reproTest = {
  file: "src/test/java/com/example/shop/OrderServiceTest.java",
  name: "OrderServiceTest#totalOfEmptyOrder",
  failure: "NullPointerException at OrderService.java:42",
};

const task = (fields: Partial<Task> = {}): Task => ({
  id: "t1",
  repo: "shop",
  prompt: "Fix the total of an empty order",
  branch: "trackwall/fix-the-total-1a2b3c",
  baseBranch: "main",
  base: "a".repeat(40),
  worktree: "/w/shop/fix-the-total-1a2b3c",
  createdAt: "2026-11-10T09:00:00Z",
  title: "Fix the total of an empty order",
  proposedBy: null,
  model: "claude-sonnet-4.5",
  approvals: "ask",
  plan: "approved",
  javaNavigation: false,
  sandbox: false,
  item: null,
  view: "conversation",
  summary: {
    text: "OrderService.total() returned null for an order without lines; it now returns zero.",
    checkSteps: ["Open /orders/new and save it empty: the total shows 0.00"],
    reproTest,
    reportedAt: "2026-11-10T10:00:00Z",
  },
  inReview: false,
  port: 41000,
  included: { files: [], problems: [] },
  change: null,
  retryOf: null,
  paused: null,
  ...fields,
});

const verification: Verification = {
  task: "t1",
  repo: "shop",
  miseTask: "test",
  state: "passed",
  runId: "r1",
  startedAt: "2026-11-10T10:05:00Z",
  finishedAt: "2026-11-10T10:06:00Z",
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
};

const reproduction = (fields: Partial<ReproductionCheck> = {}): ReproductionCheck => ({
  task: "t1",
  repo: "shop",
  test: reproTest,
  filter: "OrderServiceTest",
  state: "reproduced",
  phase: null,
  startedAt: "2026-11-10T10:07:00Z",
  finishedAt: "2026-11-10T10:09:00Z",
  base: null,
  change: null,
  message: null,
  ...fields,
});

const rulesReview = (fields: Partial<AutoReview> = {}): AutoReview => ({
  task: "t1",
  repo: "shop",
  kind: "rules",
  state: "done",
  trigger: "user",
  startedAt: "2026-11-10T10:10:00Z",
  finishedAt: "2026-11-10T10:11:00Z",
  diffHash: "0".repeat(64),
  diffTruncated: false,
  findings: [],
  text: "",
  message: null,
  ruleFiles: ["AGENTS.md", "docs/adr/0007-money-as-big-decimal.md"],
  ...fields,
});

const evidence = (fields: Partial<MergeRequestEvidence> = {}): MergeRequestEvidence => ({
  template: null,
  reproduction: reproduction(),
  rules: { review: rulesReview(), outdated: false },
  usage: {
    modelCalls: 42,
    inputTokens: 1_150_000,
    outputTokens: 50_000,
    aiCredits: 3.4,
    aiCreditsPartial: false,
    premiumRequests: 0,
  },
  models: [{ model: "claude-sonnet-4.5", modelCalls: 40 }],
  ...fields,
});

describe("the evidence from Trackwall in a merge request's draft", () => {
  test("names the approved plan, the checked reproduction, the verdict, the rules check and the model with its use", () => {
    expect(evidenceLines(task(), verification, evidence())).toEqual([
      "- Plan first: the user approved the agent's plan in Trackwall before it changed files",
      "- Reproduction test OrderServiceTest#totalOfEmptyOrder in src/test/java/com/example/shop/OrderServiceTest.java: " +
        "Trackwall checked that it fails on the base commit and passes with the change",
      "- Verification: passed (mise task test, 128 tests · 3 skipped)",
      "- Rules check against AGENTS.md, docs/adr/0007-money-as-big-decimal.md: no findings",
      "- Model: claude-sonnet-4.5 (40 calls); used 3.4 AI credits, 1.2M tokens in 42 model calls",
    ]);
  });

  test("a reproduction check that did not confirm the test says so beside the agent's word", () => {
    const [, line] = evidenceLines(
      task(),
      null,
      evidence({ reproduction: reproduction({ state: "not_reproduced", message: "The test passed on the base commit" }) }),
    );

    expect(line).toBe(
      "- Reproduction test OrderServiceTest#totalOfEmptyOrder in src/test/java/com/example/shop/OrderServiceTest.java: " +
        "Trackwall's check did not confirm it (The test passed on the base commit); the agent says it failed before the fix with: " +
        "NullPointerException at OrderService.java:42",
    );
  });

  test("a check of another test, or one still running, leaves the test as the agent's word", () => {
    const other = reproduction({ test: { ...reproTest, name: "OrderServiceTest#totalOfOneLine" } });
    for (const check of [other, reproduction({ state: "running" })])
      expect(evidenceLines(task(), null, evidence({ reproduction: check }))[1]).toStartWith("- Reproduction test (the agent's word):");
  });

  test("a rules check lists its findings with their places, and says when the changes moved on after it", () => {
    const findings = Array.from({ length: 6 }, (_, i) => ({
      title: `Field injection in OrderController ${i + 1}`,
      severity: null,
      path: i === 0 ? "src/main/java/com/example/shop/OrderController.java" : null,
      line: i === 0 ? 17 : null,
      text: "AGENTS.md: use constructor injection",
    }));
    const lines = evidenceLines(
      task({ plan: null, summary: null }),
      null,
      evidence({ rules: { review: rulesReview({ findings }), outdated: true } }),
    );

    expect(lines[0]).toBe(
      "- Rules check against AGENTS.md, docs/adr/0007-money-as-big-decimal.md on an earlier version of the changes: 6 findings" +
        "\n  - Field injection in OrderController 1 (src/main/java/com/example/shop/OrderController.java:17)" +
        "\n  - Field injection in OrderController 2\n  - Field injection in OrderController 3" +
        "\n  - Field injection in OrderController 4\n  - Field injection in OrderController 5" +
        "\n  - and 1 more finding",
    );
  });

  test("names the model asked for when Copilot CLI ran the task on others, and only tokens with a model of your own provider", () => {
    const lines = evidenceLines(
      task({ plan: null, summary: null }),
      null,
      evidence({
        rules: null,
        models: [
          { model: "auto", modelCalls: 30 },
          { model: "gpt-5-mini", modelCalls: 2 },
        ],
        usage: { modelCalls: 32, inputTokens: 900, outputTokens: 50, aiCredits: null, aiCreditsPartial: false, premiumRequests: 0 },
      }),
    );

    expect(lines).toEqual([
      "- Models: auto (30 calls), gpt-5-mini (2 calls), asked for claude-sonnet-4.5; used 950 tokens in 32 model calls",
    ]);
  });

  test("a task without a plan, a summary, a verdict or anything from the daemon has no evidence", () => {
    expect(evidenceLines(task({ plan: null, summary: null }), null, null)).toEqual([]);
    expect(evidenceLines(task({ plan: "planning", summary: null }), null, evidence({ rules: null, usage: null, models: [] }))).toEqual([]);
  });
});

describe("the draft with the repo's own template", () => {
  test("fills the summary and the evidence into the template's sections and keeps its checklist", () => {
    const template = [
      "## What does this merge request do?",
      "<!-- Describe the change -->",
      "",
      "## How to test",
      "",
      "## Checklist",
      "- [ ] Tests added",
      "- [ ] Documentation updated",
    ].join("\n");
    const draft = mergeRequestDraft({
      task: task({ plan: null }),
      verification,
      evidence: evidence({
        template: { path: ".gitlab/merge_request_templates/Default.md", text: template },
        rules: null,
        usage: null,
        models: [],
      }),
      changeBlock: null,
    });

    expect(draft.description).toBe(
      [
        "## What does this merge request do?",
        "",
        "OrderService.total() returned null for an order without lines; it now returns zero.",
        "",
        "<!-- Describe the change -->",
        "",
        "## How to test",
        "",
        "How to check:",
        "1. Open /orders/new and save it empty: the total shows 0.00",
        "",
        "Evidence from Trackwall:",
        "- Reproduction test OrderServiceTest#totalOfEmptyOrder in src/test/java/com/example/shop/OrderServiceTest.java: " +
          "Trackwall checked that it fails on the base commit and passes with the change",
        "- Verification: passed (mise task test, 128 tests · 3 skipped)",
        "",
        "## Checklist",
        "- [ ] Tests added",
        "- [ ] Documentation updated",
      ].join("\n"),
    );
  });
});
