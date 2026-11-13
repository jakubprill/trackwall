import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi, boardApi, EndedTask, workspaceApi } from "@trackwall/protocol";
import { TaskFile } from "../src/modules/agents/task-file.ts";
import { waitUntil } from "../src/platform/process-group.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A failed task retried on a stronger model (ADR-233): a new task with the same prompt from the same base commit, on the
// model the user picks, linked to the task it retries in the task list and in the task journal; a second attempt on the
// same model, and the attempt the user keeps from a comparison (ADR-251).

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n" }, web: { "README.md": "# web\n" } },
    miseCommand: ["mise"],
  });
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
  const running = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (running) await daemon.post(agentsApi.stop, { session: running.id });
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

  test("a second attempt on the same model starts like any retry, to compare two runs of one model", async () => {
    const first = await daemon.post(agentsApi.createTask, {
      repo: "shop",
      prompt: "describe the repo",
      approvals: "ask",
      model: "gpt-5-mini",
    });

    const again = await daemon.post(agentsApi.retryTask, { task: first.id, model: "gpt-5-mini" });

    expect(again).toMatchObject({ model: "gpt-5-mini", base: first.base, retryOf: first.id, prompt: "describe the repo" });
    expect(again.worktree).not.toBe(first.worktree);
    for (const task of [again, first]) await end(task.id);
  }, 60_000);

  test("ending one attempt to keep the other records the kept attempt in the task journal", async () => {
    const first = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "Fix the total", approvals: "ask", model: "gpt-5-mini" });
    const retry = await daemon.post(agentsApi.retryTask, { task: first.id, model: "claude-opus-5.5" });
    const running = daemon.facade.agents.sessions().sessions.find((s) => s.task === first.id && s.run.kind === "running");
    if (running) await daemon.post(agentsApi.stop, { session: running.id });

    await daemon.post(agentsApi.removeTask, { task: first.id, keepBranch: false, discardChanges: true, keptInstead: retry.id });

    const journal = join(daemon.home, "task-journal.jsonl");
    expect(await waitUntil(() => existsSync(journal) && readFileSync(journal, "utf8").includes(first.id), 5000)).toBe(true);
    const records = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => EndedTask.parse(JSON.parse(line)));
    expect(records.find((r) => r.task === first.id)).toMatchObject({ keptInstead: retry.id, model: "gpt-5-mini" });
    // The kept attempt goes on.
    expect(daemon.facade.agents.task(retry.id)).toMatchObject({ retryOf: first.id });
    await end(retry.id);
  }, 60_000);

  test("keeping a task that is not another attempt at the same task is refused, and the task stays", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "Fix the header", approvals: "ask" });
    const unrelated = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "Fix the footer", approvals: "ask" });
    for (const t of [task, unrelated]) {
      const running = daemon.facade.agents.sessions().sessions.find((s) => s.task === t.id && s.run.kind === "running");
      if (running) await daemon.post(agentsApi.stop, { session: running.id });
    }

    await expect(
      daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true, keptInstead: unrelated.id }),
    ).rejects.toThrow(`remove-task: task ${unrelated.branch} is not another attempt at task ${task.branch}`);
    await expect(
      daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true, keptInstead: task.id }),
    ).rejects.toThrow(`remove-task: the attempt to keep (${task.id}) is not another task on the list`);

    expect(existsSync(task.worktree)).toBe(true);
    for (const t of [task, unrelated]) await end(t.id);
  }, 60_000);

  test("the retry keeps the task's board item while it is on the board, and starts without one the user removed", async () => {
    const item = await daemon.post(boardApi.create, { kind: "item", title: "Cart sum" });
    const first = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "Fix the cart sum", approvals: "ask", item: item.id });

    const kept = await daemon.post(agentsApi.retryTask, { task: first.id, model: "claude-opus-5.5" });
    await daemon.post(boardApi.remove, { item: item.id });
    const dropped = await daemon.post(agentsApi.retryTask, { task: first.id, model: "gpt-5.5" });

    expect(kept.item).toBe(item.id);
    expect(dropped.item).toBeNull();
    for (const task of [kept, dropped, first]) await end(task.id);
  }, 60_000);

  test("the retry of a task another task handed its work keeps that handoff, so its agent reads the same work", async () => {
    const handing = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "Add the refund endpoint", approvals: "ask" });
    const subtask = await daemon.post(agentsApi.createTask, {
      repo: "web",
      prompt: "Show refunds",
      approvals: "ask",
      handoffFrom: handing.id,
    });

    const retry = await daemon.post(agentsApi.retryTask, { task: subtask.id, model: "claude-opus-5.5" });

    const stored = (id: string) => new TaskFile(join(daemon.home, "tasks.json"), () => {}).read().find((t) => t.id === id);
    expect(stored(retry.id)?.handoff).toMatchObject({ task: handing.id, repo: "shop", branch: handing.branch });
    // The retry reports to the user: the coordination with the handing task stays with the first attempt.
    expect(retry.proposedBy).toBeNull();
    for (const task of [retry, subtask, handing]) await end(task.id);
  }, 60_000);

  test("a part of a change cannot be retried on its own", async () => {
    const { tasks } = await daemon.post(agentsApi.createChange, {
      title: "Refunds",
      prompt: "Add refunds",
      parts: [
        { repo: "shop", note: "" },
        { repo: "web", note: "" },
      ],
      approvals: "ask",
    });
    const [part] = tasks;
    if (part === undefined) throw new Error("no part started");

    await expect(daemon.post(agentsApi.retryTask, { task: part.id, model: "claude-opus-5.5" })).rejects.toThrow(
      "retry-task: a part of a change cannot be retried on its own",
    );
    for (const task of tasks) await end(task.id);
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

describe.skipIf(process.versions.bun === undefined)("retrying a task in the conversation view (fake Copilot CLI over ACP)", () => {
  test("the retry keeps the conversation view and Plan first, so its agent plans again before it changes anything", async () => {
    const { agents, procs } = makeAgents({ shop: makeRepo({ "README.md": "# shop\n" }, "shop") });
    const first = await agents.createTask("shop", "Fix the login", {
      view: "conversation",
      approvals: "auto",
      planFirst: true,
      model: "gpt-5-mini",
    });

    const retry = await agents.retryTask(first.id, "claude-opus-5.5");

    expect(retry).toMatchObject({ view: "conversation", plan: "planning", approvals: "auto", model: "claude-opus-5.5", retryOf: first.id });
    await procs.stopAll();
  }, 60_000);
});
