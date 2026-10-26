import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentsApi, ProposeTaskResult, WaitForSessionResult } from "@trackwall/protocol";
import { waitFor } from "../test/support/agents.ts";
import { sessionList, showSessions, startTrackwall, type Trackwall, waitForTerminal } from "./support/trackwall-ui.ts";

// Unset when the start failed, so `afterAll` stops only what started.
let trackwall: Trackwall | undefined;

// A limit above the default 5 s: Chromium and the daemon start slowly on a Windows runner.
beforeAll(async () => {
  trackwall = await startTrackwall();
}, 60_000);

afterAll(async () => {
  await trackwall?.stop();
}, 30_000);

describe("a task proposal from a main session", () => {
  test("the user edits the prompt of a main session's proposal and starts it, and the main session follows the task with that prompt", async () => {
    if (trackwall === undefined) throw new Error("Trackwall did not start");
    const { daemon } = trackwall;
    const main = await daemon.post(agentsApi.start, { repo: "shop" });
    await waitFor(daemon.facade.agents, main.id, (s) => s.state !== null, "the main session's first state");
    // The main session's agent proposes through its MCP bridge, as Copilot CLI calls `propose_task`.
    const agent = await trackwall.agentOf(main.id);
    const { proposal } = ProposeTaskResult.parse(
      (
        await agent.callTool({
          name: "propose_task",
          arguments: { repo: "shop", title: "Add a licence", prompt: "Add an MIT LICENSE file" },
        })
      ).structuredContent,
    );

    const page = await trackwall.open();
    await showSessions(page);
    await sessionList(page)
      .getByRole("button", { name: /Task proposal/ })
      .click();
    await page.getByRole("textbox", { name: "Prompt for the agent: Add a licence" }).fill("Add an Apache-2.0 LICENSE file");
    await page.getByRole("button", { name: "Start task" }).click();

    await waitForTerminal(page, "Argument: --interactive=Add an Apache-2.0 LICENSE file");
    await sessionList(page)
      .getByRole("button", { name: /Task proposal/ })
      .waitFor({ state: "detached" });
    await sessionList(page)
      .getByRole("button", { name: /Add a licence/ })
      .waitFor();
    const followed = WaitForSessionResult.parse(
      (await agent.callTool({ name: "wait_for_session", arguments: { task: proposal.id, timeoutSeconds: 1 } })).structuredContent,
    );
    expect(followed).toMatchObject({ status: "working", task: { prompt: "Add an Apache-2.0 LICENSE file" } });
  }, 60_000);
});
