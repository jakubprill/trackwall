import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AutoReview, agentsApi, autoReviewApi, mergeRequestsApi, type Task, workspaceApi } from "@trackwall/protocol";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A task's check against the repo's rules (ADR-234) through the real facade: real git gives the diff and the rule files
// of the task's base commit, and the fake Copilot CLI answers like a model that reads them: a rule file's line
// "Never add `<text>`" is a rule, and an added line holding `<text>` breaks it (`test/fixtures/fake-copilot-acp.ts`).

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

const ROOT_RULES = "# Rules for agents\n\n- Never add `console.log` to the code.\n- Write tests.\n";
const ORDERS_RULES = "# The orders service\n\n- Never add `System.exit` here.\n";

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      ruled: {
        "README.md": "# ruled\n",
        "AGENTS.md": ROOT_RULES,
        "orders/AGENTS.md": ORDERS_RULES,
        "orders/Main.java": "class Main {}\n",
        "billing/AGENTS.md": "- Never add `float` for money.\n",
      },
      bare: { "README.md": "# bare\n" },
    },
    miseCommand: ["mise"],
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

/** A task of `repo` whose worktree has the files `files`, without a session getting in the way of the diff. */
async function taskWith(repo: string, files: Record<string, string>): Promise<Task> {
  const task = await daemon.post(agentsApi.createTask, { repo, prompt: "change it", approvals: "ask" });
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

async function settled(task: string, kind: "code" | "rules"): Promise<AutoReview> {
  const until = Date.now() + 20_000;
  for (;;) {
    const review = await daemon.post(autoReviewApi.get, { task, kind });
    if (review !== null && review.state !== "running") return review;
    if (Date.now() > until) throw new Error(`gave up waiting for the ${kind} review of ${task}: ${JSON.stringify(review)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)(
  "a check of a task's changes against the repo's rules (real git, fake Copilot CLI)",
  () => {
    test("a change that breaks a written rule gets a finding that quotes the rule, on the line that breaks it", async () => {
      const task = await taskWith("ruled", { "src/cart.ts": "export const total = 1;\nconsole.log(total);\n" });

      await daemon.post(autoReviewApi.start, { task: task.id, kind: "rules" });
      const check = await settled(task.id, "rules");

      expect(check).toMatchObject({ kind: "rules", state: "done", trigger: "user", ruleFiles: ["AGENTS.md"] });
      expect(check.findings).toEqual([
        {
          title: "console.log added",
          severity: "medium",
          path: "src/cart.ts",
          line: 2,
          text: 'Line 2 adds console.log.\n\nRule: AGENTS.md: "- Never add `console.log` to the code."\n\nSuggested fix: Take it out.',
        },
      ]);
      // Only the tools that read, and not the review agent's `task`: the check reads the rules itself.
      expect(check.text).toContain("Argument: --available-tools=view,grep,glob\n");
      // The rules' copies and the diff are outside the worktree: the daemon approved reading them, and only them.
      expect(check.message).toBeNull();
      expect(check.text).not.toContain("--add-dir");
      expect(existsSync(join(daemon.home, "auto-reviews", "rules", task.id))).toBe(false);
      // The code review is a kind of its own, which this check did not start.
      expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "code" })).toBeNull();
    });

    test("the draft of the merge request carries the check, marked outdated once the changes move on after it (ADR-238)", async () => {
      const task = await taskWith("ruled", { "src/cart.ts": "export const total = 1;\nconsole.log(total);\n" });
      expect((await daemon.post(mergeRequestsApi.evidence, { task: task.id })).rules).toBeNull();

      await daemon.post(autoReviewApi.start, { task: task.id, kind: "rules" });
      const check = await settled(task.id, "rules");

      expect((await daemon.post(mergeRequestsApi.evidence, { task: task.id })).rules).toEqual({ review: check, outdated: false });
      writeFileSync(join(task.worktree, "src", "cart.ts"), "export const total = 2;\n");
      expect((await daemon.post(mergeRequestsApi.evidence, { task: task.id })).rules).toEqual({ review: check, outdated: true });
    });

    test("a change that keeps the rules gets no finding", async () => {
      const task = await taskWith("ruled", { "src/cart.ts": "export const total = 1;\n", "orders/Order.java": "class Order {}\n" });

      await daemon.post(autoReviewApi.start, { task: task.id, kind: "rules" });
      const check = await settled(task.id, "rules");

      expect(check).toMatchObject({ state: "done", findings: [], ruleFiles: ["AGENTS.md", "orders/AGENTS.md"] });
      expect(check.text).toStartWith("No rule violations found.");
    });

    test("the AGENTS.md of a changed file's folder counts, that of a folder the change does not touch does not", async () => {
      const task = await taskWith("ruled", { "orders/Main.java": "class Main { void quit() { System.exit(1); } }\n" });

      await daemon.post(autoReviewApi.start, { task: task.id, kind: "rules" });
      const check = await settled(task.id, "rules");

      expect(check.ruleFiles).toEqual(["AGENTS.md", "orders/AGENTS.md"]);
      expect(check.findings.map((f) => [f.title, f.path, f.line])).toEqual([["System.exit added", "orders/Main.java", 1]]);
    });

    test("the rules are those of the base commit: deleting a rule or adding a rule file in the change does not get past them", async () => {
      const task = await taskWith("ruled", {
        "AGENTS.md": "# Rules for agents\n\n- Write tests.\n",
        "src/AGENTS.md": "- Anything goes here.\n",
        "src/log.ts": 'console.log("debug");\n',
      });
      rmSync(join(task.worktree, "orders", "AGENTS.md"));

      await daemon.post(autoReviewApi.start, { task: task.id, kind: "rules" });
      const check = await settled(task.id, "rules");

      // The deleted orders/AGENTS.md is a change in its folder, so its rules apply as the base commit had them.
      expect(check.ruleFiles).toEqual(["AGENTS.md", "orders/AGENTS.md"]);
      expect(check.findings.map((f) => [f.title, f.path, f.line])).toEqual([["console.log added", "src/log.ts", 1]]);
    });

    test("a repo without rules for agents has nothing to check against, and says where rules would be", async () => {
      const task = await taskWith("bare", { "src/cart.ts": "console.log(1);\n" });

      await expect(daemon.post(autoReviewApi.start, { task: task.id, kind: "rules" })).rejects.toThrow(
        `the repo of task ${task.id} has no rules for agents at the task's base commit: none of AGENTS.md, CLAUDE.md, GEMINI.md`,
      );
      expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "rules" })).toBeNull();
    });

    test("with autoReview.rulesAfterReport on, the agent's report starts the rules check and not the code review", async () => {
      const task = await daemon.post(agentsApi.createTask, { repo: "ruled", prompt: "add a log", approvals: "ask" });
      writeFileSync(join(task.worktree, "debug.ts"), "console.log(1);\n");
      const session = runningSessionOf(task.id);
      await daemon.post(workspaceApi.setAutoReview, { afterReport: false, rulesAfterReport: true });
      // Only what is on goes into the file.
      expect(readFileSync(join(daemon.home, "workspace.yaml"), "utf8")).toContain("autoReview:\n  rulesAfterReport: true\n");
      try {
        await daemon.facade.agents.reportSummary(session, { text: "Added a log.", checkSteps: [], reproTest: null });
        const check = await settled(task.id, "rules");

        expect(check).toMatchObject({ kind: "rules", state: "done", trigger: "report" });
        expect(check.findings.map((f) => f.title)).toEqual(["console.log added"]);
        expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "code" })).toBeNull();
      } finally {
        await daemon.post(workspaceApi.setAutoReview, { afterReport: false, rulesAfterReport: false });
      }
      expect(readFileSync(join(daemon.home, "workspace.yaml"), "utf8")).not.toContain("autoReview");
    });

    test("a running check and a running code review of one task both stop when the task ends", async () => {
      process.env.FAKE_COPILOT_REVIEW_WAIT = "1";
      try {
        const task = await taskWith("ruled", { "src/cart.ts": "export const total = 1;\n" });
        await daemon.post(autoReviewApi.start, { task: task.id, kind: "rules" });
        await daemon.post(autoReviewApi.start, { task: task.id, kind: "code" });

        await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });

        expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "rules" })).toBeNull();
        expect(await daemon.post(autoReviewApi.get, { task: task.id, kind: "code" })).toBeNull();
        expect(existsSync(join(daemon.home, "auto-reviews", "rules", task.id))).toBe(false);
        expect(existsSync(join(daemon.home, "auto-reviews", "code", task.id))).toBe(false);
      } finally {
        delete process.env.FAKE_COPILOT_REVIEW_WAIT;
      }
    });
  },
);
