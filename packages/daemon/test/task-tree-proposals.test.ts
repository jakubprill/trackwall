import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, type Task } from "@trackwall/protocol";
import { connectSessionClient, toolText } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "t".repeat(43);
const REPOS = ["employees", "departments", "organizations"] as const;
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: Object.fromEntries(REPOS.map((repo) => [repo, { "README.md": `# ${repo}\n` }])),
    miseCommand: ["mise"],
  });
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

/** The MCP client of task `task`'s running session. */
async function clientOfTask(task: string): Promise<Client> {
  const client = await connectSessionClient(daemon.api.port, daemon.home, runningSession(task));
  clients.push(client);
  return client;
}

function propose(client: Client, repo: string, title: string) {
  return client.callTool({ name: "propose_task", arguments: { repo, title, prompt: title } });
}

async function approved(client: Client, repo: string, title: string): Promise<Task> {
  const { proposal } = ProposeTaskResult.parse((await propose(client, repo, title)).structuredContent);
  return daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: proposal.prompt, model: null, approvals: "ask" });
}

describe.skipIf(process.versions.bun === undefined)(
  "one task per repo in a task tree (ADR-259; real PTY and git, fake Copilot CLI)",
  () => {
    test("a subtask cannot propose a repo where a task of its tree already works or is proposed; another tree can", async () => {
      // As in a run seen on a real model: the root task hands department and organization work to two subtasks.
      const root = await daemon.post(agentsApi.createTask, { repo: "employees", prompt: "Add the employee email", approvals: "ask" });
      const rootClient = await clientOfTask(root.id);
      const departments = await approved(rootClient, "departments", "Pass the email on");
      const { proposal } = ProposeTaskResult.parse((await propose(rootClient, "organizations", "Expose the email")).structuredContent);
      const departmentsClient = await clientOfTask(departments.id);

      // While the root's proposal waits for the user, the subtask cannot propose that repo again.
      expect(toolText(await propose(departmentsClient, "organizations", "Preserve the email in organizations"))).toBe(
        `bad_request: task \`${proposal.id}\` (Expose the email) of the same work is already proposed in organizations, so do not propose a second one there: say what it needs from your change in your report_result, or ask your proposer with ask_proposer, who passes it on`,
      );
      // Nor once it is a task.
      const organizations = await daemon.post(agentsApi.approveProposal, {
        proposal: proposal.id,
        prompt: proposal.prompt,
        model: null,
        approvals: "ask",
      });
      const twice = await propose(departmentsClient, "organizations", "Preserve the email in organizations");
      expect(twice.isError).toBe(true);
      expect(toolText(twice)).toBe(
        `bad_request: task \`${organizations.id}\` (Expose the email) of the same work already works in organizations, so do not propose a second one there: say what it needs from your change in your report_result, or ask your proposer with ask_proposer, who passes it on`,
      );
      expect(daemon.facade.agents.sessions().proposals).toEqual([]);

      // The root's repo is the tree's too, and the subtask's own repo is its own work.
      const organizationsClient = await clientOfTask(organizations.id);
      expect(toolText(await propose(organizationsClient, "employees", "Rename the email field"))).toStartWith(
        `bad_request: task \`${root.id}\` of the same work already works in employees, so do not propose a second one there`,
      );
      expect(toolText(await propose(organizationsClient, "organizations", "Also the address"))).toBe(
        "bad_request: organizations is your own task's repo: make the change there yourself",
      );

      // A task of another tree may still propose there: it is other work.
      const other = await daemon.post(agentsApi.createTask, { repo: "departments", prompt: "Rename departments", approvals: "ask" });
      const elsewhere = await propose(await clientOfTask(other.id), "organizations", "Rename departments in organizations");
      expect(elsewhere.isError).toBeFalsy();

      for (const task of [departments, organizations, other, root]) {
        await daemon.facade.agents.stop(runningSession(task.id));
        await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
      }
    }, 60_000);
  },
);
