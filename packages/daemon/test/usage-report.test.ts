import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsApi, usageReportApi } from "@trackwall/protocol";
import { viewer } from "./support/agents.ts";
import { untilInputBox } from "./support/screen-lines.ts";
import { FAKE_COPILOT, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "u".repeat(43);
const DAY_MS = 24 * 60 * 60 * 1000;
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const copilotHome = () => join(daemon.home, "copilot-home");

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n" } },
    miseCommand: ["mise"],
    copilot: { command: FAKE_COPILOT.command, env: ({ home }) => ({ ...process.env, COPILOT_HOME: join(home, "copilot-home") }) },
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

/** A conversation as Copilot CLI leaves it in its home: `workspace.yaml` and the event log, one model call and one tool call. */
function conversation(id: string, o: { cwd: string; branch?: string; at: Date; inputTokens: number; tool?: string }): void {
  const dir = join(copilotHome(), "session-state", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.yaml"), `cwd: ${JSON.stringify(o.cwd)}\n${o.branch === undefined ? "" : `branch: ${o.branch}\n`}`);
  const timestamp = o.at.toISOString();
  const usage = {
    inputTokens: o.inputTokens,
    outputTokens: 10,
    cost: 1,
    toolTokenCount: 1000,
    accounting: { sourceSessionId: id, sequence: 1 },
  };
  const lines = [
    { type: "session.usage_record", timestamp, data: { usage } },
    {
      type: "tool.execution_start",
      timestamp,
      data: { toolCallId: "c1", toolName: `trackwall-${o.tool}`, mcpServerName: "trackwall", mcpToolName: o.tool },
    },
    {
      type: "tool.execution_complete",
      timestamp,
      data: { toolCallId: "c1", success: true, toolTelemetry: { metrics: { result_token_count: 500 } } },
    },
  ];
  writeFileSync(join(dir, "events.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

/** Waits until the report of this week has the task: the fake writes its event log when the turn starts. */
async function untilReported(task: string): Promise<void> {
  const until = Date.now() + 20_000;
  for (;;) {
    const { work } = await daemon.post(usageReportApi.week, { weeksAgo: 0 });
    if (work.some((w) => w.task === task)) return;
    if (Date.now() > until) throw new Error(`the task's conversation is not in the report: ${JSON.stringify(work)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("the weekly usage report (ADR-199, fake Copilot CLI)", () => {
  test(
    "ranks the week's work by input tokens, ties a task's conversation to the task also after it ended, and ranks tools by result tokens",
    async () => {
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "Fix the cart total", approvals: "ask" });
      const { agents } = daemon.facade;
      const session = agents.sessions().sessions.find((s) => s.task === task.id);
      if (session === undefined) throw new Error("the task has no session");
      const window = viewer(agents, session.id);
      await untilInputBox(window, "empty");
      // The task's prompt is the session's only turn: the fake writes its receipt at the start, as Copilot CLI sends a
      // prompt given at the start to the model at once. A second, typed turn would race the stop below for its receipt.
      await untilReported(task.id);
      window.attachment.detach();
      await agents.stop(session.id);
      const now = Date.now();
      conversation("supervisor-1", { cwd: daemon.projects, at: new Date(now - DAY_MS), inputTokens: 50_000, tool: "list_repos" });
      conversation("repo-1", {
        cwd: join(daemon.projects, "shop"),
        branch: "main",
        at: new Date(now - 2 * DAY_MS),
        inputTokens: 20_000,
        tool: "get_repo",
      });
      conversation("elsewhere-1", { cwd: tmpdir(), at: new Date(now - 3 * DAY_MS), inputTokens: 1_000, tool: "get_repo" });
      conversation("last-week-1", { cwd: daemon.projects, at: new Date(now - 9 * DAY_MS), inputTokens: 7_000, tool: "list_repos" });
      await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });

      const week = await daemon.post(usageReportApi.week, { weeksAgo: 0 });

      expect(week.work.map((w) => [w.kind, w.repo, w.usage.inputTokens])).toEqual([
        ["supervisor", null, 50_000],
        ["repo", "shop", 20_000],
        ["outside", null, 1_000],
        ["task", "shop", 100],
      ]);
      expect(week.work[3]).toMatchObject({ task: task.id, label: "Fix the cart total", conversations: 1, toolDefinitionTokens: 60 });
      expect(week.total).toMatchObject({ modelCalls: 4, inputTokens: 71_100, premiumRequests: 4 });
      expect(week.toolDefinitionTokens).toBe(3060);
      expect(week.tools).toEqual([
        { tool: "get_repo", server: "trackwall", calls: 2, failures: 0, resultTokens: 1000 },
        { tool: "list_repos", server: "trackwall", calls: 1, failures: 0, resultTokens: 500 },
        { tool: "view", server: null, calls: 1, failures: 0, resultTokens: 4 },
      ]);
      expect(week.unreadLogs).toBe(0);

      const before = await daemon.post(usageReportApi.week, { weeksAgo: 1 });
      expect(before.work.map((w) => [w.kind, w.usage.inputTokens])).toEqual([["supervisor", 7_000]]);
      expect(Date.parse(before.to) - Date.parse(before.from)).toBe(7 * DAY_MS);
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
