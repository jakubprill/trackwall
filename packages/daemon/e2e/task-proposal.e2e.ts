import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, WaitForSessionResult } from "@trackwall/protocol";
import { waitFor } from "../test/support/agents.ts";
import { connectSessionClient } from "../test/support/mcp-client.ts";
import { startTrackwall, type Trackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const TOKEN = "p".repeat(43);
let trackwall: Trackwall;
const clients: Client[] = [];

beforeAll(async () => {
  trackwall = await startTrackwall(TOKEN);
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await trackwall.stop();
}, 30_000);

describe("a task proposal from a main session", () => {
  test("the user reads a proposal the main session made, edits its prompt and starts it, and the task's agent gets the edited prompt", async () => {
    const { daemon } = trackwall;
    const main = await daemon.post(agentsApi.start, { repo: "shop" });
    await waitFor(daemon.facade.agents, main.id, (s) => s.state !== null, "the main session's first state");
    // The main session's agent proposes through its MCP bridge, as Copilot CLI calls `propose_task`.
    const agent = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, main.id);
    clients.push(agent);
    const { proposal } = ProposeTaskResult.parse(
      (
        await agent.callTool({
          name: "propose_task",
          arguments: { repo: "shop", title: "Add a licence", prompt: "Add an MIT LICENSE file" },
        })
      ).structuredContent,
    );

    const page = await trackwall.open();
    await page.keyboard.press("Control+3");
    await page
      .getByRole("navigation", { name: "Session list" })
      .getByRole("button", { name: /Task proposal/ })
      .click();
    await page.getByRole("textbox", { name: "Prompt for the agent: Add a licence" }).fill("Add an Apache-2.0 LICENSE file");
    await page.getByRole("button", { name: "Start task" }).click();

    await waitForTerminal(page, "Argument: --interactive=Add an Apache-2.0 LICENSE file");
    const list = page.getByRole("navigation", { name: "Session list" });
    await list.getByRole("button", { name: /Task proposal/ }).waitFor({ state: "detached" });
    await list.getByRole("button", { name: /Add a licence/ }).waitFor();

    // The main session's agent follows its task: it runs, with the prompt the user started it with.
    const followed = WaitForSessionResult.parse(
      (await agent.callTool({ name: "wait_for_session", arguments: { task: proposal.id, timeoutSeconds: 1 } })).structuredContent,
    );
    expect(followed).toMatchObject({ status: "working", task: { prompt: "Add an Apache-2.0 LICENSE file" } });
  }, 60_000);
});
