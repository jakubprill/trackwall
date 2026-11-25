import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, TRACKWALL_DIR, workspaceApi } from "@trackwall/protocol";
import { waitFor } from "./support/agents.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "d".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
/** Fake mise config (see `fixtures/fake-mise.ts`): `dev` runs until stopped. */
const MISE_CONFIG = JSON.stringify({ tasks: [{ name: "dev" }] });
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall, to propose tasks for a repo the user then removes. */
let outside: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      orders: { "README.md": "# orders\n", "notes.txt": "kept\n" },
      shop: { "README.md": "# shop\n" },
      cart: { "README.md": "# cart\n" },
      billing: { "fake-mise.json": MISE_CONFIG },
      archive: { "README.md": "# archive\n" },
      legacy: { "README.md": "# legacy\n" },
    },
    miseCommand: FAKE_MISE,
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await outside.close();
  await daemon.stop();
}, 30_000);

const removedDir = () => join(daemon.projects, TRACKWALL_DIR, "removed");
const repoIds = async () => (await daemon.post(workspaceApi.list, {})).repos.map((r) => r.id);

describe.skipIf(process.versions.bun === undefined)("the user removes a repo from the Repos view", () => {
  test("with its name typed, the repo's folder moves into the removed repos folder with every file and leaves the list", async () => {
    const { movedTo } = await daemon.post(agentsApi.removeRepo, { repo: "orders", confirmation: "orders" });

    expect(movedTo).toBe(join(removedDir(), "orders"));
    expect(readFileSync(join(movedTo, "notes.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(movedTo, ".git"))).toBe(true);
    expect(existsSync(join(daemon.projects, "orders"))).toBe(false);
    expect(await repoIds()).not.toContain("orders");
  });

  test("a confirmation that is not exactly the repo's name moves nothing", async () => {
    for (const confirmation of ["", "Shop", " shop", "shop ", "cart"])
      await expect(daemon.post(agentsApi.removeRepo, { repo: "shop", confirmation })).rejects.toThrow(
        "type the repo's name, shop, to remove it",
      );

    expect(existsSync(join(daemon.projects, "shop", "README.md"))).toBe(true);
  });

  test("a repo with a task is not removed until the user ends the task", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a test", approvals: "ask" });

    await expect(daemon.post(agentsApi.removeRepo, { repo: "shop", confirmation: "shop" })).rejects.toThrow(
      "end the tasks of shop first (1): their worktrees belong to the repo",
    );
    expect(existsSync(join(daemon.projects, "shop", "README.md"))).toBe(true);

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (session) {
      await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the task's first state");
      await daemon.facade.agents.stop(session.id);
    }
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
    await daemon.post(agentsApi.removeRepo, { repo: "shop", confirmation: "shop" });

    expect(existsSync(join(removedDir(), "shop", "README.md"))).toBe(true);
  }, 30_000);

  test("a repo with a session running in its root is not removed until the session stops", async () => {
    const session = await daemon.facade.agents.start("cart");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the first state");

    await expect(daemon.post(agentsApi.removeRepo, { repo: "cart", confirmation: "cart" })).rejects.toThrow(
      "stop the sessions in cart first (1 running)",
    );

    await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeRepo, { repo: "cart", confirmation: "cart" });
    expect(existsSync(join(removedDir(), "cart"))).toBe(true);
  }, 30_000);

  test("a repo with a mise task running in it is not removed until the mise task stops", async () => {
    await outside.callTool({ name: "run_mise_task", arguments: { repo: "billing", miseTask: "dev" } });

    await expect(daemon.post(agentsApi.removeRepo, { repo: "billing", confirmation: "billing" })).rejects.toThrow(
      "stop the mise tasks, services and terminals running in billing first",
    );

    await outside.callTool({ name: "stop_mise_task", arguments: { repo: "billing", miseTask: "dev" } });
    await daemon.post(agentsApi.removeRepo, { repo: "billing", confirmation: "billing" });
    expect(existsSync(join(removedDir(), "billing", "fake-mise.json"))).toBe(true);
  }, 30_000);

  test("removing a repo rejects the proposals for it, which could no longer start, and its own removal proposal", async () => {
    const task = ProposeTaskResult.parse(
      (await outside.callTool({ name: "propose_task", arguments: { repo: "archive", title: "Fix", prompt: "fix" } })).structuredContent,
    ).proposal;
    const removal = ProposeTaskResult.parse(
      (
        await outside.callTool({
          name: "propose_folder_action",
          arguments: { action: "remove_repo", repo: "archive", reason: "Unused" },
        })
      ).structuredContent,
    ).proposal;

    await daemon.post(agentsApi.removeRepo, { repo: "archive", confirmation: "archive" });

    const waiting = daemon.facade.agents.sessions().proposals.map((p) => p.id);
    expect(waiting).not.toContain(task.id);
    expect(waiting).not.toContain(removal.id);
  });

  test("a second removal of a repo already being removed is refused, and the first one moves it once", async () => {
    const first = daemon.facade.agents.removeRepo("legacy", "legacy");
    await expect(daemon.facade.agents.removeRepo("legacy", "legacy")).rejects.toThrow("legacy is already being removed");

    expect(await first).toBe(join(removedDir(), "legacy"));
    expect(existsSync(join(removedDir(), "legacy-2"))).toBe(false);
  });

  test("a repo that is not in the projects folder is refused", async () => {
    await expect(daemon.post(agentsApi.removeRepo, { repo: "nope", confirmation: "nope" })).rejects.toThrow("nope");
  });
});
