import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, GetUpdatesResult, ProposeTaskResult, REMOVED_REPOS_DIR, workspaceApi } from "@trackwall/protocol";
import { waitFor } from "./support/agents.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "c".repeat(43);
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
    },
    miseCommand: ["mise"],
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function proposeRemoval(client: Client, repo: string, reason: string) {
  const result = await client.callTool({ name: "propose_folder_action", arguments: { action: "remove_repo", repo, reason } });
  return ProposeTaskResult.parse(result.structuredContent).proposal;
}

const removedDir = () => join(daemon.projects, REMOVED_REPOS_DIR);
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
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a test" });
    const proposal = await proposeRemoval(outside, "shop", "Archived");

    await expect(daemon.post(agentsApi.approveRepoRemoval, { proposal: proposal.id })).rejects.toThrow(
      "end the tasks of shop first (1): their worktrees belong to the repo",
    );
    expect(existsSync(join(daemon.projects, "shop"))).toBe(true);
    expect(daemon.facade.agents.sessions().proposals.map((p) => p.id)).toContain(proposal.id);

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (session) {
      await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the task's first state");
      await daemon.facade.agents.stop(session.id);
    }
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

    await expect(daemon.post(agentsApi.approveProposal, { proposal: removal.id, prompt: "x" })).rejects.toThrow("is not a task");
    await expect(daemon.post(agentsApi.approveRepoRemoval, { proposal: task.id })).rejects.toThrow("is not a repo removal");
    const unknown = await outside.callTool({
      name: "propose_folder_action",
      arguments: { action: "remove_repo", repo: "nope", reason: "x" },
    });
    expect(unknown.isError).toBe(true);

    await daemon.post(agentsApi.rejectProposal, { proposal: removal.id });
    await daemon.post(agentsApi.rejectProposal, { proposal: task.id });
  });
});
