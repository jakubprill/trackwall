import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AutoReview, agentsApi, autoReviewApi, type Task, workspaceApi } from "@trackwall/protocol";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// "Explain this diff" (ADR-250) through the real facade: real git gives the task's diff, and the fake Copilot CLI answers
// like a model that reads it, in the three sections the prompt asks for (`test/fixtures/fake-copilot-acp.ts`).

const TOKEN = "x".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

/** A task of prompt `prompt` whose worktree has the files `files`, without a session getting in the way of the diff. */
async function taskWith(prompt: string, files: Record<string, string>): Promise<Task> {
  const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt, approvals: "ask" });
  await daemon.facade.agents.stop(runningSessionOf(task.id));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(task.worktree, path, ".."), { recursive: true });
    writeFileSync(join(task.worktree, path), content);
  }
  return task;
}

function runningSessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

async function settled(task: string): Promise<AutoReview> {
  const until = Date.now() + 20_000;
  for (;;) {
    const review = await daemon.post(autoReviewApi.get, { task, kind: "explain" });
    if (review !== null && review.state !== "running") return review;
    if (Date.now() > until) throw new Error(`gave up waiting for the explanation of ${task}: ${JSON.stringify(review)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("an explanation of a task's changes (real git, fake Copilot CLI)", () => {
  test("Explain this diff gives the explanation in Markdown, from the task's prompt and its diff, with only the tools that read", async () => {
    const task = await taskWith("Add a cart total and a tax", {
      "src/cart.ts": "export const total = 1;\nexport const tax = 0;\n",
      "src/tax.ts": "export const rate = 0.23;\n",
    });

    const started = await daemon.post(autoReviewApi.start, { task: task.id, kind: "explain" });
    expect(started).toMatchObject({ kind: "explain", state: "running", trigger: "user", findings: [] });
    const explanation = await settled(task.id);

    expect(explanation).toMatchObject({ kind: "explain", state: "done", findings: [], message: null, ruleFiles: [] });
    expect(explanation.text).toStartWith(
      [
        "## Summary",
        "The change does what the task asks: Add a cart total and a tax",
        "## Changes",
        "- `src/cart.ts`: 2 added lines.",
        "- `src/tax.ts`: 1 added line.",
        "## Worth a closer look",
        "Nothing stands out.",
      ].join("\n"),
    );
    // Only the tools that read, without the review agent's `task`, and the diff read with the daemon's approval alone.
    expect(explanation.text).toContain("Argument: --available-tools=view,grep,glob\n");
    expect(explanation.text).toContain("Argument: --deny-tool=shell\n");
    expect(explanation.text).not.toContain("--add-dir");
    expect(existsSync(join(daemon.home, "auto-reviews", "explain", task.id))).toBe(false);
    // An explanation is a kind of its own: it starts neither a review nor a rules check.
    expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "code" })).toBeNull();
    expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "rules" })).toBeNull();
  });

  test("an explainer refused reading the diff, which then answers nothing, fails and names what was refused", async () => {
    const task = await taskWith("Add a fee", { "src/fee.ts": "export const fee = 1;\n" });
    // A file outside the worktree and the review's folder stands for a diff the explainer could not read.
    const elsewhere = join(daemon.projects, "..", "not-the-diff-to-explain.patch");
    writeFileSync(elsewhere, "+export const fee = 1;\n");
    process.env.FAKE_COPILOT_REVIEW_FILE = elsewhere;
    try {
      await daemon.post(autoReviewApi.start, { task: task.id, kind: "explain" });
      const explanation = await settled(task.id);

      expect(explanation).toMatchObject({
        state: "failed",
        text: "",
        message: `Copilot CLI gave no explanation; it was refused: Access paths outside trusted directories: ${elsewhere}`,
      });
    } finally {
      delete process.env.FAKE_COPILOT_REVIEW_FILE;
    }
  });

  test("the agent's report starts no explanation, even with both automatic reviews on", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a coupon", approvals: "ask" });
    writeFileSync(join(task.worktree, "coupon.ts"), "export const coupon = 5;\n");
    await daemon.post(workspaceApi.setAutoReview, { afterReport: true, rulesAfterReport: true });
    try {
      await daemon.facade.agents.reportSummary(runningSessionOf(task.id), { text: "Added a coupon.", checkSteps: [], reproTest: null });
      const until = Date.now() + 20_000;
      while ((await daemon.post(autoReviewApi.get, { task: task.id, kind: "code" }))?.state !== "done" && Date.now() < until)
        await new Promise((r) => setTimeout(r, 50));

      expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "code" })).toMatchObject({ trigger: "report", state: "done" });
      expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "explain" })).toBeNull();
    } finally {
      await daemon.post(workspaceApi.setAutoReview, { afterReport: false, rulesAfterReport: false });
    }
  });

  test("ending the task stops a running explanation and forgets it", async () => {
    process.env.FAKE_COPILOT_REVIEW_WAIT = "1";
    try {
      const task = await taskWith("add a discount", { "src/discount.ts": "export const discount = 2;\n" });
      await daemon.post(autoReviewApi.start, { task: task.id, kind: "explain" });

      await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });

      expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "explain" })).toBeNull();
      expect(existsSync(join(daemon.home, "auto-reviews", "explain", task.id))).toBe(false);
    } finally {
      delete process.env.FAKE_COPILOT_REVIEW_WAIT;
    }
  });
});
