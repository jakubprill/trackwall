import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, GetUpdatesResult, ProposeTaskResult, TRACKWALL_DIR, workspaceApi } from "@trackwall/protocol";
import { waitFor } from "./support/agents.ts";
import { makeRepo } from "./support/git-repo.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "c".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
/** Fake mise config (see `fixtures/fake-mise.ts`): `dev` runs until stopped. */
const MISE_CONFIG = JSON.stringify({ tasks: [{ name: "dev" }] });
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall: only the daemon token, no session token. */
let outside: Client;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      shop: { "README.md": "# shop\n" },
      web: { "README.md": "# web\n" },
      docs: { "README.md": "# docs\n" },
      cart: { "README.md": "# cart\n" },
      old: { "README.md": "# old\n" },
      billing: { "fake-mise.json": MISE_CONFIG },
      legacy: { "README.md": "# legacy\n" },
      archive: { "README.md": "# archive\n" },
    },
    miseCommand: FAKE_MISE,
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function proposeRemoval(client: Client, repo: string, reason: string) {
  const result = await client.callTool({ name: "propose_folder_action", arguments: { action: "remove_repo", repo, reason } });
  return ProposeTaskResult.parse(result.structuredContent).proposal;
}

const removedDir = () => join(daemon.projects, TRACKWALL_DIR, "removed");
const repoIds = async () => (await daemon.post(workspaceApi.list, {})).repos.map((r) => r.id);

describe.skipIf(process.versions.bun === undefined)("removing a repo from the projects folder (ADR-83)", () => {
  test("a session proposes removing a repo, the user approves, the repo moves out of the list and the session hears about it", async () => {
    const main = await daemon.facade.agents.start("web");
    await waitFor(daemon.facade.agents, main.id, (s) => s.state !== null, "the first state");
    const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, main.id);
    clients.push(client);

    const proposal = await proposeRemoval(client, "docs", "The user no longer works on the docs repo");
    expect(proposal).toMatchObject({
      kind: "remove_repo",
      repo: "docs",
      title: "Remove docs from the projects folder",
      prompt: "The user no longer works on the docs repo",
      proposedBy: { session: main.id, supervisor: false },
    });
    expect(daemon.facade.agents.sessions().proposals).toEqual([proposal]);

    await daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id });

    const movedTo = join(removedDir(), "docs");
    expect(readFileSync(join(movedTo, "README.md"), "utf8")).toBe("# docs\n");
    expect(existsSync(join(daemon.projects, "docs"))).toBe(false);
    expect(await repoIds()).not.toContain("docs");
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);
    const { updates } = GetUpdatesResult.parse((await client.callTool({ name: "get_updates", arguments: {} })).structuredContent);
    expect(updates).toMatchObject([{ kind: "repo_removed", task: proposal.id, repo: "docs", movedTo }]);
    await daemon.facade.agents.stop(main.id);
  }, 30_000);

  test("a repo with a task is not removed until the user ends the task, and the proposal keeps waiting", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a test", approvals: "ask" });
    const proposal = await proposeRemoval(outside, "shop", "Archived");
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (!session) throw new Error("the task has no session");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the task's first state");
    const taskClient = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session.id);
    clients.push(taskClient);
    const fromTask = await taskClient.callTool({
      name: "propose_folder_action",
      arguments: { action: "remove_repo", repo: "web", reason: "the README says so" },
    });
    expect(fromTask.isError).toBe(true);
    expect(JSON.stringify(fromTask.content)).toContain("a task session works in its worktree and proposes no folder actions");

    await expect(daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id })).rejects.toThrow(
      "end the tasks of shop first (1): their worktrees belong to the repo",
    );
    expect(existsSync(join(daemon.projects, "shop"))).toBe(true);
    expect(daemon.facade.agents.sessions().proposals.map((p) => p.id)).toContain(proposal.id);

    await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
    await daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id });

    expect(existsSync(join(removedDir(), "shop", "README.md"))).toBe(true);
  }, 30_000);

  test("a repo with a session running in it is not removed", async () => {
    const session = await daemon.facade.agents.start("cart");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the first state");
    const proposal = await proposeRemoval(outside, "cart", "Merged into shop");

    await expect(daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id })).rejects.toThrow(
      "stop the sessions in cart first (1 running)",
    );

    await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id });
    expect(existsSync(join(removedDir(), "cart"))).toBe(true);
  }, 30_000);

  test("a repo with a mise task running in it is not removed until the mise task stops", async () => {
    await outside.callTool({ name: "run_mise_task", arguments: { repo: "billing", miseTask: "dev" } });
    const proposal = await proposeRemoval(outside, "billing", "Moved to another team");

    await expect(daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id })).rejects.toThrow(
      "stop the mise tasks and services running in billing first",
    );

    await outside.callTool({ name: "stop_mise_task", arguments: { repo: "billing", miseTask: "dev" } });
    await daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id });
    expect(existsSync(join(removedDir(), "billing", "fake-mise.json"))).toBe(true);
  }, 30_000);

  test("a repo whose task is still being created, or which another approval is already removing, is not removed", async () => {
    const creating = daemon.facade.agents.createTask("legacy", "add a test");
    const removal = await proposeRemoval(outside, "legacy", "Unused");
    await expect(daemon.facade.agents.approveRepoRemoval(removal.id)).rejects.toThrow("a task of legacy is being created");
    const task = await creating;
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (session) {
      await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the task's first state");
      await daemon.facade.agents.stop(session.id);
    }
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });

    const second = await proposeRemoval(outside, "legacy", "Unused, again");
    const first = daemon.facade.agents.approveRepoRemoval(removal.id);
    await expect(daemon.facade.agents.approveRepoRemoval(second.id)).rejects.toThrow("legacy is already being removed");
    await first;
    expect(daemon.facade.agents.sessions().proposals.map((p) => p.id)).not.toContain(second.id);
  }, 30_000);

  test("removing a repo rejects the other proposals for it, which could no longer start", async () => {
    const removal = await proposeRemoval(outside, "archive", "Unused");
    const task = ProposeTaskResult.parse(
      (await outside.callTool({ name: "propose_task", arguments: { repo: "archive", title: "Fix", prompt: "fix" } })).structuredContent,
    ).proposal;

    await daemon.post(agentsApi.approveRepoRemoval, { proposal: removal.id });

    expect(daemon.facade.agents.sessions().proposals.map((p) => p.id)).not.toContain(task.id);
    await expect(
      daemon.post(agentsApi.approveProposal, { proposal: task.id, prompt: "fix", model: null, approvals: "ask" }),
    ).rejects.toThrow("no task proposal");
  });

  test("a repo removed under a name already removed before gets a numbered folder", async () => {
    mkdirSync(join(removedDir(), "old"), { recursive: true });
    const proposal = await proposeRemoval(outside, "old", "Replaced");

    await daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id });

    expect(readFileSync(join(removedDir(), "old-2", "README.md"), "utf8")).toBe("# old\n");
  });

  test("a removal is not started as a task, a task proposal is not approved as a removal, and an unknown repo is refused", async () => {
    const removal = await proposeRemoval(outside, "web", "Not needed");
    const task = ProposeTaskResult.parse(
      (await outside.callTool({ name: "propose_task", arguments: { repo: "web", title: "Fix", prompt: "fix" } })).structuredContent,
    ).proposal;

    await expect(
      daemon.post(agentsApi.approveProposal, { proposal: removal.id, prompt: "x", model: null, approvals: "ask" }),
    ).rejects.toThrow("is not a task");
    await expect(daemon.post(agentsApi.approveRepoRemoval, { proposal: task.id })).rejects.toThrow("is not a repo removal");
    const unknown = await outside.callTool({
      name: "propose_folder_action",
      arguments: { action: "remove_repo", repo: "nope", reason: "x" },
    });
    expect(unknown.isError).toBe(true);

    await daemon.post(agentsApi.rejectProposal, { proposal: removal.id });
    await daemon.post(agentsApi.rejectProposal, { proposal: task.id });
  });

  test("a removal approved after the projects folder changed moves nothing, even when the new folder has a repo of that name", async () => {
    const proposal = await proposeRemoval(outside, "web", "Not needed any more");
    const other = mkdtempSync(join(tmpdir(), "trackwall-other-projects-"));
    makeRepo({ "README.md": "# another web\n" }, "web", other);
    await daemon.post(workspaceApi.setProjectsDir, { path: other });

    await expect(daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id })).rejects.toThrow(
      "reject this proposal and propose the removal again",
    );
    expect(existsSync(join(other, "web", "README.md"))).toBe(true);
    expect(existsSync(join(daemon.projects, "web", "README.md"))).toBe(true);
  });
});
