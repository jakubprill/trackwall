import { describe, expect, test } from "bun:test";
import type { CopilotUsage, EndedTask } from "@trackwall/protocol";
import { modelStats } from "../src/modules/task-journal/model-stats.ts";

const NOW = new Date("2026-11-08T12:00:00Z");

/** An ended task; the fields a test does not name are those of a task typed by the user and ended without commits. */
function ended(n: number, endedAt: string, more: Partial<EndedTask> = {}): EndedTask {
  return {
    task: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    repo: "shop",
    title: null,
    prompt: `task ${n}`,
    branch: `trackwall/task-${n}`,
    baseBranch: "main",
    base: "a".repeat(40),
    head: null,
    branchKept: false,
    createdAt: endedAt,
    endedAt,
    proposed: false,
    item: null,
    handoffFrom: null,
    summary: null,
    commits: [],
    commitsTotal: null,
    files: [],
    filesTruncated: false,
    verification: null,
    model: null,
    usage: null,
    models: [],
    ...more,
  };
}

function credits(aiCredits: number | null, modelCalls = 10): CopilotUsage {
  return { modelCalls, inputTokens: 1000, outputTokens: 100, aiCredits, aiCreditsPartial: false, premiumRequests: 0 };
}

describe("model statistics", () => {
  test("each model gets its tasks, how they ended and what they used together, the model with most tasks first", () => {
    const records = [
      ended(1, "2026-11-01T10:00:00Z", {
        models: [{ model: "gpt-6", modelCalls: 12 }],
        verification: { state: "passed", finishedAt: "2026-11-01T09:00:00Z" },
        commitsTotal: 2,
        usage: credits(30),
      }),
      ended(2, "2026-11-02T10:00:00Z", {
        models: [{ model: "gpt-6", modelCalls: 20 }],
        verification: { state: "failed", finishedAt: "2026-11-02T09:00:00Z" },
        commitsTotal: 1,
        usage: credits(50),
      }),
      ended(3, "2026-11-03T10:00:00Z", { models: [{ model: "gpt-6", modelCalls: 4 }], commitsTotal: 0, usage: credits(10) }),
      ended(4, "2026-11-04T10:00:00Z", {
        models: [{ model: "claude-sonnet-5.5", modelCalls: 8 }],
        verification: { state: "passed", finishedAt: "2026-11-04T09:00:00Z" },
        commitsTotal: 3,
        usage: credits(90),
      }),
    ];

    expect(modelStats(records, "30d", NOW)).toEqual({
      period: "30d",
      models: [
        {
          model: "gpt-6",
          tasks: 3,
          verified: 1,
          failed: 1,
          withCommits: 2,
          askedForAnother: 0,
          sharedWithAnother: 0,
          usage: { modelCalls: 30, inputTokens: 3000, outputTokens: 300, aiCredits: 90, aiCreditsPartial: false, premiumRequests: 0 },
          tasksWithUsage: 3,
        },
        {
          model: "claude-sonnet-5.5",
          tasks: 1,
          verified: 1,
          failed: 0,
          withCommits: 1,
          askedForAnother: 0,
          sharedWithAnother: 0,
          usage: { modelCalls: 10, inputTokens: 1000, outputTokens: 100, aiCredits: 90, aiCreditsPartial: false, premiumRequests: 0 },
          tasksWithUsage: 1,
        },
      ],
      withoutModel: 0,
    });
  });

  test("a task counts for the model that made most of its calls, not the one it asked for, and says so", () => {
    const records = [
      ended(1, "2026-11-01T10:00:00Z", {
        model: "claude-opus-5.5",
        models: [
          { model: "gpt-6-mini", modelCalls: 9 },
          { model: "claude-opus-5.5", modelCalls: 2 },
        ],
      }),
      ended(2, "2026-11-01T11:00:00Z", { model: "auto", models: [{ model: "gpt-6-mini", modelCalls: 3 }] }),
      ended(3, "2026-11-01T12:00:00Z", { model: "gpt-6-mini", models: [{ model: "gpt-6-mini", modelCalls: 3 }] }),
    ];

    expect(modelStats(records, "all", NOW).models).toMatchObject([
      { model: "gpt-6-mini", tasks: 3, askedForAnother: 1, sharedWithAnother: 1 },
    ]);
  });

  test("tasks ended before the period, and tasks without a recorded model, are in no row", () => {
    const records = [
      ended(1, "2026-08-01T10:00:00Z", { models: [{ model: "gpt-6", modelCalls: 1 }] }),
      ended(2, "2026-10-20T10:00:00Z", { models: [{ model: "gpt-6", modelCalls: 1 }] }),
      ended(3, "2026-11-05T10:00:00Z"),
    ];

    expect(modelStats(records, "30d", NOW)).toMatchObject({ models: [{ model: "gpt-6", tasks: 1 }], withoutModel: 1 });
    expect(modelStats(records, "90d", NOW)).toMatchObject({ models: [{ model: "gpt-6", tasks: 1 }], withoutModel: 1 });
    expect(modelStats(records, "all", NOW)).toMatchObject({ models: [{ model: "gpt-6", tasks: 2 }], withoutModel: 1 });
  });

  test("usage sums only the tasks that recorded it, and is partial when some reported no AI credits", () => {
    const records = [
      ended(1, "2026-11-01T10:00:00Z", { models: [{ model: "gpt-6", modelCalls: 1 }], usage: credits(5) }),
      ended(2, "2026-11-01T11:00:00Z", { models: [{ model: "gpt-6", modelCalls: 1 }], usage: credits(null) }),
      ended(3, "2026-11-01T12:00:00Z", { models: [{ model: "gpt-6", modelCalls: 1 }] }),
    ];

    expect(modelStats(records, "all", NOW).models).toMatchObject([
      { tasks: 3, tasksWithUsage: 2, usage: { aiCredits: 5, aiCreditsPartial: true, modelCalls: 20 } },
    ]);
  });
});
