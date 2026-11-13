import { describe, expect, test } from "bun:test";
import type { CopilotUsage, ModelStats, ModelStatsRow } from "@trackwall/protocol";
import {
  fewTasks,
  perTask,
  perTaskDetails,
  perVerifiedTask,
  perVerifiedTaskDetails,
  rowNotes,
  share,
  verdict,
  withoutModelNote,
} from "../src/lib/model-stats";

function usage(aiCredits: number | null, premiumRequests = 0): CopilotUsage {
  return { modelCalls: 40, inputTokens: 400_000, outputTokens: 8000, aiCredits, aiCreditsPartial: false, premiumRequests };
}

function row(model: string, more: Partial<ModelStatsRow> = {}): ModelStatsRow {
  return {
    model,
    tasks: 10,
    verified: 0,
    failed: 0,
    withCommits: 0,
    askedForAnother: 0,
    sharedWithAnother: 0,
    keptInComparison: 0,
    droppedInComparison: 0,
    usage: null,
    tasksWithUsage: 0,
    tasksWithCredits: 0,
    ...more,
  };
}

function stats(...models: ModelStatsRow[]): ModelStats {
  return { period: "30d", models, withoutModel: 0 };
}

describe("model statistics in Settings", () => {
  test("a share shows the count of the whole and its percent", () => {
    expect(share(3, 5)).toBe("3 of 5 · 60%");
    expect(share(0, 4)).toBe("0 of 4");
  });

  test("a model with fewer than five tasks is too few to compare", () => {
    expect(fewTasks({ tasks: 4 })).toBe(true);
    expect(fewTasks({ tasks: 5 })).toBe(false);
  });

  test("one task costs the average over the tasks whose usage is recorded", () => {
    expect(perTask(row("gpt-6", { tasks: 5, tasksWithUsage: 4, tasksWithCredits: 4, usage: usage(80) }))).toMatchObject({
      aiCredits: 20,
      modelCalls: 10,
    });
    expect(perTask(row("gpt-6"))).toBeNull();
  });

  test("a passed verification costs what all the model's tasks cost, over the tasks that passed", () => {
    // 4 tasks at 20 credits each, 2 passed: each pass cost 40 credits.
    expect(
      perVerifiedTask(row("gpt-6", { tasks: 4, verified: 2, tasksWithUsage: 4, tasksWithCredits: 4, usage: usage(80) })),
    ).toMatchObject({ aiCredits: 40 });
    expect(perVerifiedTask(row("gpt-6", { tasks: 4, verified: 0, tasksWithUsage: 4, tasksWithCredits: 4, usage: usage(80) }))).toBeNull();
  });

  test("AI credits average over the tasks that reported them, so tasks without credits do not make a model look cheap", () => {
    // 4 tasks with usage, 2 of them reported 60 credits together: a task cost 30, not 15.
    const mixed = row("gpt-6", { tasks: 4, tasksWithUsage: 4, tasksWithCredits: 2, usage: { ...usage(60), aiCreditsPartial: true } });

    expect(perTask(mixed)).toMatchObject({ aiCredits: 30, modelCalls: 10 });
  });

  test("the tooltips say what the costs are over", () => {
    const some = row("gpt-6", { tasks: 5, verified: 2, tasksWithUsage: 4, tasksWithCredits: 4, usage: usage(80) });

    expect(perTaskDetails(some)).toBe("The average of 4 tasks with recorded usage; 1 task without it is left out");
    expect(perVerifiedTaskDetails(some)).toBe("What all 5 tasks cost, over the 2 that passed verification");
  });

  test("notes say how many tasks started on another model or also ran on one", () => {
    expect(rowNotes(row("gpt-6", { askedForAnother: 2, sharedWithAnother: 1 }))).toEqual([
      "2 tasks started on another model",
      "1 task also ran on another model",
    ]);
    expect(rowNotes(row("gpt-6"))).toEqual([]);
  });

  test("a model whose attempts were compared side by side says how often the user kept them", () => {
    expect(rowNotes(row("claude-opus-5.5", { keptInComparison: 2, droppedInComparison: 1 }))).toEqual(["kept in 2 of 3 comparisons"]);
    expect(rowNotes(row("gpt-6-mini", { droppedInComparison: 1 }))).toEqual(["kept in 0 of 1 comparison"]);
  });

  test("the verdict names the model that passes most often and the one cheapest per pass", () => {
    const strong = row("claude-opus-5.5", { tasks: 10, verified: 8, tasksWithUsage: 10, tasksWithCredits: 10, usage: usage(400) });
    const cheap = row("gpt-6-mini", { tasks: 10, verified: 5, tasksWithUsage: 10, tasksWithCredits: 10, usage: usage(100) });

    expect(verdict(stats(strong, cheap))).toBe(
      "claude-opus-5.5 passes verification most often (80% of its tasks). gpt-6-mini costs the least per verified task (20 AI credits).",
    );
  });

  test("no verdict from one model, from models with too few tasks, or when nothing passed", () => {
    const enough = row("gpt-6", { tasks: 6, verified: 3 });

    expect(verdict(stats(enough))).toBeNull();
    expect(verdict(stats(enough, row("claude-sonnet-5.5", { tasks: 2, verified: 2 })))).toBeNull();
    expect(verdict(stats(row("gpt-6", { tasks: 6 }), row("gpt-6-mini", { tasks: 6 })))).toBeNull();
  });

  test("without AI credits the verdict names only the model that passes most often", () => {
    const byRequests = (model: string, verified: number) =>
      row(model, { tasks: 5, verified, tasksWithUsage: 5, tasksWithCredits: 0, usage: usage(null, 10) });

    expect(verdict(stats(byRequests("gpt-6", 4), byRequests("gpt-6-mini", 2)))).toBe(
      "gpt-6 passes verification most often (80% of its tasks).",
    );
  });

  test("tasks without a recorded model get a note under the table", () => {
    expect(withoutModelNote({ ...stats(), withoutModel: 3 })).toBe(
      "3 ended tasks have no model recorded (ended before Trackwall kept it, or Copilot CLI's log was missing), so they are not counted.",
    );
    expect(withoutModelNote(stats())).toBeNull();
  });
});
