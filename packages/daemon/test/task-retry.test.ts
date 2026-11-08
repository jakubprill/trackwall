import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi, EndedTask, workspaceApi } from "@trackwall/protocol";
import { waitUntil } from "../src/platform/process-group.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A failed task retried on a stronger model (ADR-232): a new task with the same prompt from the same base commit, on the
// model the user picks, linked to the task it retries in the task list and in the task journal.

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

function sessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** The fake Copilot CLI's screen once it printed its arguments, the last one starting with `last`. */
async function argumentsOf(session: string, last: string): Promise<string> {
  const window = viewer(daemon.facade.agents, session);
  await waitFor(daemon.facade.agents, session, () => window.text().includes(`Argument: ${last}`), `${last} on the screen`);
  window.attachment.detach();
  return window.text();
}

async function end(task: string): Promise<void> {
  await daemon.post(agentsApi.stop, { session: sessionOf(task) });
  await daemon.post(agentsApi.removeTask, { task, keepBranch: false, discardChanges: true });
}

describe.skipIf(process.versions.bun === undefined)("retrying a task on another model (real PTY and git, fake Copilot CLI)", () => {
  test("the retry runs the same prompt from the same base commit on the stronger model, linked to the task it retries", async () => {
    const first = await daemon.post(agentsApi.createTask, {
      repo: "shop",
      prompt: "Fix the login form",
      approvals: "ask",
      model: "gpt-5-mini",
    });
    expect(first.retryOf).toBeNull();
    // The default branch moves on after the first attempt started; the retry must still start where the first one did.
    const repo = join(daemon.projects, "shop");
    commitFiles(repo, { "CHANGELOG.md": "later work\n" }, "Later work on main");
    expect(gitIn(repo, "rev-parse", "HEAD").trim()).not.toBe(first.base);

    const retry = await daemon.post(agentsApi.retryTask, { task: first.id, model: "claude-opus-5.5" });

    expect(retry).toMatchObject({
      repo: "shop",
      prompt: "Fix the login form",
      model: "claude-opus-5.5",
      base: first.base,
      baseBranch: first.baseBranch,
      retryOf: first.id,
      approvals: "ask",
    });
    expect(retry.id).not.toBe(first.id);
    expect(retry.branch).not.toBe(first.branch);
    expect(gitIn(retry.worktree, "rev-parse", "HEAD").trim()).toBe(first.base);
    const screen = await argumentsOf(sessionOf(retry.id), "--session-id=");
    expect(screen).toContain("Argument: --model=claude-opus-5.5");
    expect(screen).not.toContain("--model=gpt-5-mini");
    // The first attempt goes on as it was, for the user to compare and end.
    expect(daemon.facade.agents.task(first.id)).toMatchObject({ model: "gpt-5-mini", retryOf: null });

    await end(retry.id);
    await end(first.id);

    const journal = join(daemon.home, "task-journal.jsonl");
    expect(await waitUntil(() => existsSync(journal) && readFileSync(journal, "utf8").includes(first.id), 5000)).toBe(true);
    const records = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => EndedTask.parse(JSON.parse(line)));
    expect(records.find((r) => r.task === retry.id)).toMatchObject({ retryOf: first.id, model: "claude-opus-5.5", base: first.base });
    expect(records.find((r) => r.task === first.id)).toMatchObject({ retryOf: null, model: "gpt-5-mini" });
  }, 60_000);

  test("a retry on the model the task already runs on is refused before a worktree exists", async () => {
    const task = await daemon.post(agentsApi.createTask, {
      repo: "shop",
      prompt: "describe the repo",
      approvals: "ask",
      model: "gpt-5-mini",
    });
    const tasksBefore = daemon.facade.agents.tasks().length;

    await expect(daemon.post(agentsApi.retryTask, { task: task.id, model: "gpt-5-mini" })).rejects.toThrow(
      "retry-task: the task already runs on gpt-5-mini; pick another model",
    );

    expect(daemon.facade.agents.tasks()).toHaveLength(tasksBefore);
    await end(task.id);
  }, 60_000);

  test("the retry model is kept in workspace.yaml for the next failed task, and cleared again", async () => {
    expect((await daemon.post(workspaceApi.settings, {})).retryModel).toBeNull();

    const saved = await daemon.post(workspaceApi.setRetryModel, { model: "claude-opus-5.5" });

    expect(saved).toMatchObject({ retryModel: "claude-opus-5.5", retryModelProblem: null });
    expect(readFileSync(join(daemon.home, "workspace.yaml"), "utf8")).toContain("retryModel: claude-opus-5.5");
    expect((await daemon.post(workspaceApi.setRetryModel, { model: null })).retryModel).toBeNull();
    expect(readFileSync(join(daemon.home, "workspace.yaml"), "utf8")).not.toContain("retryModel");
  });
});
