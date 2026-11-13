import { describe, expect, test } from "bun:test";
import { agentsApi, workspaceApi } from "@trackwall/protocol";
import { waitFor } from "../test/support/agents.ts";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

const WARNING = /1 task already runs; this one makes 2, more than the 1 this computer is set to warn above/;

describe("the running tasks warning (ADR-244)", () => {
  test("with the computer set to warn above 1 task and one running, the New session form warns before a second task and still starts it", async () => {
    const { daemon } = trackwall();
    await daemon.post(workspaceApi.setRunningTasksWarning, { above: 1 });
    const first = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "Add a README section", approvals: "ask" });
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === first.id);
    if (session === undefined) throw new Error("the first task has no session");
    await waitFor(daemon.facade.agents, session.id, (s) => s.run.kind === "running", "the first task running");

    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("button", { name: "New task or Copilot CLI session" }).click();
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill("Add a licence");

    await page.getByRole("status").filter({ hasText: WARNING }).waitFor();
    // Only a warning: the start is the user's call.
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, "--interactive=Add a licence");
    expect(daemon.facade.agents.sessions().tasks.map((t) => t.prompt).sort()).toEqual(["Add a README section", "Add a licence"]);
  }, 60_000);
});
