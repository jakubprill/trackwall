import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SMALL_SCREEN, showSessions, typeInTerminal, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const FAKE_MISE = [process.execPath, join(import.meta.dir, "..", "test", "fixtures", "fake-mise.ts")];
/**
 * The fake mise (see `test/fixtures/fake-mise.ts`): `test` fails, so the verdict fills the task panel, and `dev` runs
 * until stopped, so the panel lists it.
 */
const SHOP_MISE = JSON.stringify({ tasks: [{ name: "test" }, { name: "dev" }], exits: { test: 1 } });
const PROMPT = "Add a discount to the cart";
const SUMMARY = [
  "Added a discount to the cart, with a test for an empty cart and one for a cart over the limit.",
  "Committed on the task branch. The mise test task fails on an unrelated test, which the user should check.",
  "Started the dev service on the task port and called GET / on it, which answered 200.",
].join("\n");

const trackwall = useTrackwall({
  repos: { shop: { "README.md": "# shop\n", "fake-mise.json": SHOP_MISE, ".gitignore": "calls.log\npids\n" } },
  miseCommand: FAKE_MISE,
});

describe("a small screen", () => {
  test("with a summary and a verdict above it, the task's terminal still shows the whole approval dialog, answered from the tray panel", async () => {
    const { daemon } = trackwall();
    const page = await trackwall().open(SMALL_SCREEN);
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill(PROMPT);
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, `--interactive=${PROMPT}`);

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task !== null);
    if (session === undefined) throw new Error("the task has no session");
    const agent = await trackwall().agentOf(session.id);
    await agent.callTool({ name: "report_result", arguments: { summary: SUMMARY } });
    await page.getByRole("list", { name: "Task notices" }).getByText("Summary").waitFor();
    await page.getByRole("button", { name: "Details" }).click();
    await agent.callTool({ name: "run_mise_task", arguments: { repo: "shop", task: session.task, miseTask: "dev" } });
    await page.getByRole("region", { name: "mise tasks in this worktree" }).getByText("dev").waitFor();
    const summary = page.getByRole("region", { name: "Summary from the task session" });
    await summary.getByText("Committed on the task branch").waitFor();
    // Two of the summary's three lines show until it is opened, so that it does not push the terminal down.
    const closed = await summary.boundingBox();
    await summary.getByRole("button", { name: "Show all" }).click();
    const opened = await summary.boundingBox();
    if (closed === null || opened === null) throw new Error("the summary is not on the screen");
    expect(opened.height).toBeGreaterThan(closed.height);
    await summary.getByRole("button", { name: "Show less" }).click();
    expect((await summary.boundingBox())?.height).toBe(closed.height);
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByRole("region", { name: "Verification" }).getByText("failed").first().waitFor();

    await typeInTerminal(page, "go on\r");
    // The dialog's heading is its top line: the terminal is tall enough for the whole dialog.
    await waitForTerminal(page, "Do you want to run this command?");
    await waitForTerminal(page, "Create a file");

    const panel = await trackwall().openTrayPanel();
    const waiting = panel.getByRole("list", { name: "Waiting for you" });
    await waiting.getByText("Create a file").waitFor();
    await waiting.getByRole("button", { name: "Yes", exact: true }).click();
    await panel.getByText("Nothing is waiting for you.").waitFor();
  }, 90_000);

  test("Home with the supervisor panel pinned keeps the 3D scene wide enough to read", async () => {
    const page = await trackwall().open(SMALL_SCREEN);
    await page.getByRole("button", { name: /Pin the supervisor panel open/ }).click();
    const canvas = page.locator("canvas").first();
    await canvas.waitFor();

    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(320);
  }, 60_000);
});
