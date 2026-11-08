import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoReview, AutoReviewKind, Task } from "@trackwall/protocol";
import { REVIEWER_TOOLS } from "../src/modules/agents/auto-review-run.ts";
import { waitFor } from "../test/support/agents.ts";
import { commitFiles } from "../test/support/git-repo.ts";
import { startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ModelRequest, type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// The contract of the automatic review (ADR-182) with the real Copilot CLI: `/review` over ACP as the daemon starts it,
// against the scripted model. What the daemon relies on: `/review` asks the model to run the review agent through the
// `task` tool and passes the daemon's text on; the model and the review agent get only `REVIEWER_TOOLS`; a file outside
// the worktree and the diff's folder needs an approval, which the daemon refuses; and the answer of the turn is what
// the daemon reads the findings from. The fake's `/review` (`test/fixtures/fake-copilot-acp.ts`) answers in the same shape.

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;

const SESSION_MS = 60_000;
setDefaultTimeout(4 * SESSION_MS);

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model);
});

afterEach(async () => {
  const { agents } = daemon.facade;
  for (const session of agents.sessions().sessions) if (session.run.kind === "running") await agents.stop(session.id);
  expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
});

afterAll(async () => {
  await daemon.stop();
  await model.close();
});

/** A task whose session has ended its first turn, with a new file in its worktree. */
async function taskWithChange(prompt: string): Promise<Task> {
  const { agents } = daemon.facade;
  model.reply({ text: "Done." });
  const task = await agents.createTask("shop", prompt);
  const session = agents.sessions().sessions.find((s) => s.task === task.id);
  if (session === undefined) throw new Error(`task ${task.id} has no session`);
  await waitFor(agents, session.id, (s) => s.state?.reason === "hook agentStop", "end of the task's turn", SESSION_MS);
  await agents.stop(session.id);
  mkdirSync(join(task.worktree, "src"), { recursive: true });
  writeFileSync(join(task.worktree, "src", "cart.ts"), "export const total = 1;\n");
  return task;
}

async function settled(task: string, kind: AutoReviewKind = "code"): Promise<AutoReview> {
  const until = Date.now() + 2 * SESSION_MS;
  for (;;) {
    const review = daemon.facade.agents.autoReview(task, kind);
    if (review !== null && review.state !== "running") return review;
    if (Date.now() > until) throw new Error(`gave up waiting for the review: ${JSON.stringify(review)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ISSUE = (file: string) =>
  [
    "## Issue: Total is never used",
    `**File:** ${file}:1`,
    "**Severity:** Medium",
    "**Problem:** Nothing reads `total`.",
    "**Suggested fix:** Use it or drop it.",
  ].join("\n");

/** The path in the daemon's prompt, which names the diff file in backticks. */
const diffFileIn = (request: ModelRequest) => /in the file `([^`]+)`/.exec(request.lastUserText)?.[1] ?? "";

describe("an automatic review with the real Copilot CLI", () => {
  test("/review runs the review agent with only the tools that read, which reads the diff file and reports in its format", async () => {
    const task = await taskWithChange("add a cart total");
    const issue = ISSUE(join(task.worktree, "src", "cart.ts"));
    let diffFile = "";
    model.reply(
      (request) => {
        diffFile = diffFileIn(request);
        return {
          tool: "task",
          arguments: { agent_type: "code-review", name: "reviewer", description: "Review", prompt: `Review ${diffFile}` },
        };
      },
      () => ({ tool: "view", arguments: { path: diffFile } }),
      { text: issue },
      { text: issue },
    );

    await daemon.facade.agents.startAutoReview(task.id, "code");
    const review = await settled(task.id);

    const [main, agent, afterView, afterAgent] = model.requests().slice(-4);
    expect(main?.lastUserText).toContain('Use the task tool with agent_type: "code-review"');
    expect(main?.lastUserText).toContain(`Additional instructions: The changes to review are this branch's work`);
    expect(diffFile).toBe(join(daemon.home, "auto-reviews", "code", task.id, "changes.diff"));
    expect([...(main?.tools ?? [])].sort()).toEqual([...REVIEWER_TOOLS].sort());
    expect([...(agent?.tools ?? [])].sort()).toEqual([...REVIEWER_TOOLS].sort());
    // The diff's folder is readable without an approval (`--add-dir`), and the diff is the task's change.
    expect(afterView?.toolResults.join("")).toContain("+export const total = 1;");
    expect(afterAgent?.toolResults.join("")).toContain("## Issue: Total is never used");
    expect(review).toMatchObject({ state: "done", message: null });
    // Copilot CLI's notice and the model's answer are paragraphs of their own; the review agent's text is not read twice.
    expect(review.text).toStartWith("Info: Disabled tools: ");
    expect(review.text.split("## Issue:")).toHaveLength(2);
    expect(review.text).toEndWith(`\n\n${issue}`);
    expect(review.findings).toEqual([
      {
        title: "Total is never used",
        severity: "medium",
        path: "src/cart.ts",
        line: 1,
        text: "Nothing reads `total`.\n\nSuggested fix: Use it or drop it.",
      },
    ]);
  });

  test("the reviewer has no shell or file changes, and reading outside the worktree is refused", async () => {
    const task = await taskWithChange("add a cart tax");
    // Outside the worktree, the diff's folder and the system's temporary folder, which Copilot CLI lets every session read.
    const secret = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "win.ini") : "/etc/passwd";
    const marker = join(task.worktree, "made-by-reviewer.txt");
    model.reply(
      { tool: "bash", arguments: { command: `echo x > ${marker}`, description: "Write a file" } },
      { tool: "create", arguments: { path: marker, file_text: "x" } },
      { tool: "view", arguments: { path: secret } },
    );

    await daemon.facade.agents.startAutoReview(task.id, "code");
    const review = await settled(task.id);

    const [, afterShell, afterCreate] = model.requests().slice(-3);
    expect(afterShell?.toolResults.join("")).toContain("Tool 'bash' does not exist");
    expect(afterCreate?.toolResults.join("")).toContain("Tool 'create' does not exist");
    expect(existsSync(marker)).toBe(false);
    // Refusing the read ends the turn: the review is done without findings and says what was refused.
    expect(review).toMatchObject({
      state: "done",
      findings: [],
      message: "The reviewer asked for more than reading the task and was refused: Access paths outside trusted directories",
    });
  });

  // Last, since it commits rules to the repo that every later task would start from.
  test("a check against the repo's rules gets only view, grep and glob, reads the rules' copies freely and reports in the asked format", async () => {
    commitFiles(join(daemon.projects, "shop"), { "AGENTS.md": "# Rules\n\n- Never export a constant named `total`.\n" }, "Add rules");
    const task = await taskWithChange("add a cart total");
    let rulesDir = "";
    const violation = [
      "## Issue: A constant named total",
      "**File:** src/cart.ts:1",
      "**Severity:** Medium",
      '**Rule:** AGENTS.md: "Never export a constant named `total`."',
      "**Problem:** The change exports `total`.",
      "**Suggested fix:** Rename it.",
    ].join("\n");
    model.reply(
      (request) => {
        rulesDir = /copied into the folder `([^`]+)`/.exec(request.lastUserText)?.[1] ?? "";
        return { tool: "view", arguments: { path: join(rulesDir, "AGENTS.md") } };
      },
      { text: violation },
    );

    await daemon.facade.agents.startAutoReview(task.id, "rules");
    const check = await settled(task.id, "rules");

    const [main, afterView] = model.requests().slice(-2);
    expect(main?.lastUserText).toContain("\n\nCheck whether a change keeps the written rules of this repository.");
    expect(main?.lastUserText).toContain("\n- AGENTS.md\n");
    expect(rulesDir).toBe(join(daemon.home, "auto-reviews", "rules", task.id, "rules"));
    expect([...(main?.tools ?? [])].sort()).toEqual(["glob", "grep", "view"]);
    // The rules' copies are in the review's folder, which the reviewer reads without an approval (`--add-dir`).
    expect(afterView?.toolResults.join("")).toContain("Never export a constant named `total`.");
    expect(check).toMatchObject({ kind: "rules", state: "done", message: null, ruleFiles: ["AGENTS.md"] });
    expect(check.findings).toEqual([
      {
        title: "A constant named total",
        severity: "medium",
        path: "src/cart.ts",
        line: 1,
        text: 'The change exports `total`.\n\nRule: AGENTS.md: "Never export a constant named `total`."\n\nSuggested fix: Rename it.',
      },
    ]);
  });
});
