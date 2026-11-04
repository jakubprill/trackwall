import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, type Task, type TaskProposal } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "i".repeat(43);
const CONTROLLER = "src/main/java/com/example/orders/api/OrdersController.java";
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: Object.fromEntries(["orders-api", "orders-bff", "legacy-reports"].map((repo) => [repo, fixtureFiles(repo)])),
    miseCommand: ["mise"],
  });
  // Round commits (ADR-168) carry the user's own identity, which git takes from the repo's config here.
  gitIn(join(daemon.projects, "orders-api"), "config", "user.name", "Repo User");
  gitIn(join(daemon.projects, "orders-api"), "config", "user.email", "user@example.com");
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

function runningSession(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

function proposals(): TaskProposal[] {
  return daemon.facade.agents.sessions().proposals;
}

/** The user drives one turn of the task's session: the fake asks for one approval, which ends it. */
async function endTurn(session: string): Promise<void> {
  const window = viewer(daemon.facade.agents, session);
  window.attachment.input("go on\r");
  await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the approval");
  window.attachment.input("1");
  await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Input", "the end of the turn");
  window.attachment.detach();
}

/** Waits until `check` holds, up to 20 s. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function changeOrdersContract(): Promise<Task> {
  const task = await daemon.post(agentsApi.createTask, { repo: "orders-api", prompt: "Cancel orders by POST", approvals: "ask" });
  commitFiles(
    task.worktree,
    {
      [CONTROLLER]: readFileSync(join(daemon.projects, "orders-api", CONTROLLER), "utf8").replace(
        "method = RequestMethod.PUT",
        "method = RequestMethod.POST",
      ),
    },
    "Cancel by POST",
  );
  return task;
}

describe.skipIf(process.versions.bun === undefined)(
  "impact proposals: the end of a task's turn proposes a task to each repo that calls an endpoint its commits changed (ADR-198; real PTY, git and cards, fake Copilot CLI)",
  () => {
    test("the repo calling a removed endpoint gets one proposal from the task, which becomes its subtask on approval and does not come back after a rejection", async () => {
      const task = await changeOrdersContract();
      const session = runningSession(task.id);
      // Nothing is proposed before the turn ends.
      expect(proposals()).toEqual([]);

      await endTurn(session);
      await eventually(() => proposals().length > 0, "the impact proposal");

      const [proposal] = proposals();
      expect(proposals()).toHaveLength(1);
      expect(proposal).toMatchObject({
        kind: "task",
        repo: "legacy-reports",
        title: "Update to the API change in orders-api",
        model: null,
        approvals: "ask",
        fromImpact: true,
        proposedBy: { session, supervisor: false, task: task.id },
      });
      expect(proposal?.prompt).toBe(
        [
          "The task “Cancel orders by POST” in orders-api changes endpoints that legacy-reports calls:",
          "- removed PUT /api/orders/{id}/cancel, called by OrdersReport at src/main/java/com/example/reports/OrdersReport.java:21",
          "",
          "Update legacy-reports to the new contract. Read that task's change with get_changed_endpoints and get_task_changes before you change code.",
        ].join("\n"),
      );

      // A rejected proposal is not made again by the next turn with the same change.
      daemon.facade.agents.rejectProposal(proposal?.id ?? "", "Reports are retired next month");
      await endTurn(session);
      await new Promise((r) => setTimeout(r, 500));
      expect(proposals()).toEqual([]);

      await daemon.facade.agents.stop(session);
      await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
    }, 60_000);

    test("an approved impact proposal is the task's subtask, and the agent's own proposal for that repo replaces the daemon's", async () => {
      const task = await changeOrdersContract();
      const session = runningSession(task.id);
      await endTurn(session);
      await eventually(() => proposals().length > 0, "the impact proposal");
      const [fromImpact] = proposals();

      // The task's agent proposes the same repo itself: its prompt says what to do, so the daemon's goes.
      const client = await connectSessionClient(daemon.api.port, daemon.home, session);
      clients.push(client);
      const own = ProposeTaskResult.parse(
        (
          await client.callTool({
            name: "propose_task",
            arguments: { repo: "legacy-reports", title: "Cancel reports by POST", prompt: "call POST /api/orders/{id}/cancel" },
          })
        ).structuredContent,
      ).proposal;
      expect(proposals().map((p) => [p.id, p.fromImpact])).toEqual([[own.id, false]]);
      expect(proposals().some((p) => p.id === fromImpact?.id)).toBe(false);

      const subtask = await daemon.post(agentsApi.approveProposal, {
        proposal: own.id,
        prompt: own.prompt,
        model: null,
        approvals: "ask",
      });
      expect(subtask.proposedBy).toEqual({ session, supervisor: false, task: task.id });
      expect(proposals()).toEqual([]);

      for (const s of [runningSession(subtask.id), session]) await daemon.facade.agents.stop(s);
      for (const t of [subtask.id, task.id]) await daemon.post(agentsApi.removeTask, { task: t, keepBranch: false, discardChanges: true });
    }, 60_000);
  },
);
