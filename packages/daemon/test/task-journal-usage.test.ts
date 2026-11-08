import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi, EndedTask, taskJournalApi } from "@trackwall/protocol";
import { waitUntil } from "../src/platform/process-group.ts";
import { waitFor } from "./support/agents.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// The task journal keeps the model a task asked for, the models Copilot CLI ran it on and what it used (ADR-228).

const TOKEN = "j".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  // The fake falls back to the account's first model as Copilot CLI does, and writes its receipts to the event log in
  // its own home, like Copilot CLI.
  daemon = await startSessionApi(TOKEN, {
    ...ONE_REPO,
    copilot: {
      command: FAKE_COPILOT.command,
      env: ({ home }) => ({ ...process.env, COPILOT_HOME: join(home, "copilot-home"), FAKE_COPILOT_ACCOUNT_MODELS: "gpt-6-luna" }),
    },
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

describe.skipIf(process.versions.bun === undefined)("the model and usage of an ended task (real PTY and git, fake Copilot CLI)", () => {
  test("an ended task's record names the model it asked for, the model Copilot CLI ran it on and what its conversation used", async () => {
    const { agents } = daemon.facade;
    const task = await daemon.post(agentsApi.createTask, {
      repo: "shop",
      prompt: "describe the repo",
      approvals: "auto",
      model: "claude-sonnet-5.5",
    });
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task started no session");
    await waitFor(agents, session.id, (s) => s.usage !== null, "the first model call's receipt", 30_000);
    await daemon.post(agentsApi.stop, { session: session.id });

    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });

    const journal = join(daemon.home, "task-journal.jsonl");
    expect(await waitUntil(() => existsSync(journal) && readFileSync(journal, "utf8").includes(task.id), 5000)).toBe(true);
    const lines = readFileSync(journal, "utf8").trim().split("\n");
    const record = lines.map((line) => EndedTask.parse(JSON.parse(line))).find((r) => r.task === task.id);
    expect(record).toMatchObject({
      model: "claude-sonnet-5.5",
      models: [{ model: "gpt-6-luna", modelCalls: 1 }],
      usage: { modelCalls: 1 },
    });

    // The model statistics (ADR-230) credit the task to the model Copilot CLI ran it on, not the one it asked for.
    const stats = await daemon.post(taskJournalApi.modelStats, { period: "30d" });
    expect(stats.models).toMatchObject([
      { model: "gpt-6-luna", tasks: 1, askedForAnother: 1, tasksWithUsage: 1, tasksWithCredits: 0, usage: { modelCalls: 1 } },
    ]);
    expect(stats.withoutModel).toBe(0);
  }, 60_000);
});
