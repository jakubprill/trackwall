import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AutoReview, agentsApi, autoReviewApi, type Task, workspaceApi } from "@trackwall/protocol";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A task's automatic review (ADR-182) through the real facade: the reviewer is the fake Copilot CLI over ACP in the
// task's worktree, real git gives it the diff, and the review ends in findings for the "Changes" tab.

const TOKEN = "v".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

/** A task whose worktree has one new file with two lines, without a session getting in the way of the diff. */
async function taskWithChange(prompt: string): Promise<Task> {
  const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt, approvals: "ask" });
  mkdirSync(join(task.worktree, "src"), { recursive: true });
  writeFileSync(join(task.worktree, "src", "cart.ts"), "export const total = 1;\nexport const tax = 0;\n");
  return task;
}

async function settled(task: string): Promise<AutoReview> {
  const until = Date.now() + 20_000;
  for (;;) {
    const review = await daemon.post(autoReviewApi.get, { task });
    if (review !== null && review.state !== "running") return review;
    if (Date.now() > until) throw new Error(`gave up waiting for the review of ${task}: ${JSON.stringify(review)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function runningSessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

describe.skipIf(process.versions.bun === undefined)("an automatic review of a task's changes (real git, fake Copilot CLI)", () => {
  test("Review reads the task's diff with only the tools that read, refuses every approval and gives findings", async () => {
    const task = await taskWithChange("add a cart total");
    const sessionsBefore = daemon.facade.agents.sessions().sessions.length;

    const started = await daemon.post(autoReviewApi.start, { task: task.id });
    expect(started).toMatchObject({ task: task.id, repo: "shop", state: "running", trigger: "user", findings: [] });
    // A second click while it runs joins it.
    expect(await daemon.post(autoReviewApi.start, { task: task.id })).toMatchObject({ startedAt: started.startedAt });
    const review = await settled(task.id);

    expect(review).toMatchObject({
      state: "done",
      diffTruncated: false,
      message: "The reviewer asked for more than reading the task and was refused: Make a file",
    });
    expect(review.findings).toEqual([
      {
        title: "Fake finding in src/cart.ts",
        severity: "high",
        path: "src/cart.ts",
        line: 1,
        text: "The fake reviewer flags line 1.\n\nSuggested fix: Look at it again.",
      },
    ]);
    // The fake asked to run its shell command: nobody watches the reviewer, so the daemon said no.
    expect(review.text).toContain("Shell: refused");
    for (const argument of [
      "--available-tools=view,grep,glob,task,read_agent,list_agents",
      "--deny-tool=shell",
      "--deny-tool=write",
      "--deny-tool=url",
      "--disable-builtin-mcps",
      "--no-ask-user",
      "--disallow-temp-dir",
    ])
      expect(review.text).toContain(`Argument: ${argument}`);
    expect(review.text).toContain(`Argument: --add-dir=${join(daemon.home, "auto-reviews", task.id)}`);
    expect(review.text).not.toContain("--allow-all-tools");
    // Not a session: nobody sees or steers it, and the diff's folder goes with it.
    expect(daemon.facade.agents.sessions().sessions).toHaveLength(sessionsBefore);
    expect(existsSync(join(daemon.home, "auto-reviews", task.id))).toBe(false);
  });

  test("a task without changes has nothing to review", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "change nothing", approvals: "ask" });

    await expect(daemon.post(autoReviewApi.start, { task: task.id })).rejects.toThrow(`task ${task.id} has no changes to review`);
    expect(await daemon.post(autoReviewApi.get, { task: task.id })).toBeNull();
  });

  test("with autoReview.afterReport on, the agent's report starts a review once per diff", async () => {
    const task = await taskWithChange("add a tax");
    const session = runningSessionOf(task.id);

    await daemon.facade.agents.reportSummary(session, { text: "Added a tax.", checkSteps: [], reproTest: null });
    await new Promise((r) => setTimeout(r, 300));
    expect(await daemon.post(autoReviewApi.get, { task: task.id })).toBeNull();

    expect(await daemon.post(workspaceApi.setAutoReview, { afterReport: true })).toMatchObject({
      autoReview: { afterReport: true },
      autoReviewProblem: null,
    });
    await daemon.facade.agents.reportSummary(session, { text: "Added a tax.", checkSteps: [], reproTest: null });
    const first = await settled(task.id);
    expect(first).toMatchObject({ state: "done", trigger: "report" });

    // The same diff is not reviewed again; a changed one is.
    await daemon.facade.agents.reportSummary(session, { text: "Added a tax again.", checkSteps: [], reproTest: null });
    await new Promise((r) => setTimeout(r, 300));
    expect(await daemon.post(autoReviewApi.get, { task: task.id })).toEqual(first);
    writeFileSync(join(task.worktree, "src", "tax.ts"), "export const rate = 0.23;\n");
    await daemon.facade.agents.reportSummary(session, { text: "Added the rate.", checkSteps: [], reproTest: null });
    await new Promise((r) => setTimeout(r, 300));
    const second = await settled(task.id);
    expect(second.diffHash).not.toBe(first.diffHash);

    // A click while the report's start gives way for the same diff still reviews it.
    await daemon.facade.agents.reportSummary(session, { text: "Nothing new.", checkSteps: [], reproTest: null });
    expect(await daemon.facade.agents.startAutoReview(task.id)).toMatchObject({ state: "running", trigger: "user" });
    await settled(task.id);

    await daemon.post(workspaceApi.setAutoReview, { afterReport: false });
    expect(readdirSync(daemon.home)).toContain("workspace.yaml");
  });

  test("Cancel stops the reviewer, and ending the task stops one that runs", async () => {
    process.env.FAKE_COPILOT_REVIEW_WAIT = "1";
    try {
      const task = await taskWithChange("add a discount");
      await daemon.post(autoReviewApi.start, { task: task.id });
      const cancelled = await daemon.post(autoReviewApi.cancel, { task: task.id });
      expect(cancelled).toMatchObject({ state: "cancelled", message: "Stopped before the reviewer finished" });

      await daemon.post(autoReviewApi.start, { task: task.id });
      await daemon.facade.agents.stop(runningSessionOf(task.id));
      await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
      expect(await daemon.post(autoReviewApi.get, { task: task.id })).toBeNull();

      // Ending a task while its review is still starting waits for the start and stops the reviewer it began.
      const other = await taskWithChange("add a coupon");
      await daemon.facade.agents.stop(runningSessionOf(other.id));
      const starting = daemon.facade.agents.startAutoReview(other.id);
      await daemon.facade.agents.removeTask(other.id, false, true);
      expect(await starting).toMatchObject({ state: "running" });
      expect(daemon.facade.agents.autoReview(other.id)).toBeNull();
      expect(existsSync(join(daemon.home, "auto-reviews", other.id))).toBe(false);
    } finally {
      delete process.env.FAKE_COPILOT_REVIEW_WAIT;
    }
  });
});

describe.skipIf(process.versions.bun === undefined)("an automatic review across a daemon restart", () => {
  test("a review the stop ends comes back cancelled, a finished one with its findings", async () => {
    const first = await startSessionApi("w".repeat(43));
    let restarted: Awaited<ReturnType<typeof startSessionApi>> | undefined;
    try {
      const done = await first.post(agentsApi.createTask, { repo: "shop", prompt: "review me", approvals: "ask" });
      writeFileSync(join(done.worktree, "notes.md"), "a note\n");
      await first.post(autoReviewApi.start, { task: done.id });
      const until = Date.now() + 20_000;
      while ((await first.post(autoReviewApi.get, { task: done.id }))?.state === "running" && Date.now() < until)
        await new Promise((r) => setTimeout(r, 50));
      const finished = await first.post(autoReviewApi.get, { task: done.id });

      process.env.FAKE_COPILOT_REVIEW_WAIT = "1";
      const running = await first.post(agentsApi.createTask, { repo: "shop", prompt: "review me later", approvals: "ask" });
      writeFileSync(join(running.worktree, "notes.md"), "another note\n");
      await first.post(autoReviewApi.start, { task: running.id });
      await first.stop();
      delete process.env.FAKE_COPILOT_REVIEW_WAIT;

      restarted = await startSessionApi("w".repeat(43), { ...{ repos: {}, miseCommand: ["mise"] }, restartOf: first });
      expect(await restarted.post(autoReviewApi.get, { task: done.id })).toEqual(finished);
      expect(await restarted.post(autoReviewApi.get, { task: running.id })).toMatchObject({
        state: "cancelled",
        message: "Trackwall stopped during the review; review again",
      });
    } finally {
      delete process.env.FAKE_COPILOT_REVIEW_WAIT;
      await restarted?.stop();
    }
  });
});
