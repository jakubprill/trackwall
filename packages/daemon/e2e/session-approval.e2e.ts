import { afterAll, beforeAll, describe, test } from "bun:test";
import { openTrayPanel, sessionRow, startTrackwall, type Trackwall, typeInTerminal, waitForTerminal } from "./support/trackwall-ui.ts";

const TOKEN = "e".repeat(43);
let trackwall: Trackwall;

beforeAll(async () => {
  trackwall = await startTrackwall(TOKEN);
});

afterAll(async () => {
  await trackwall.stop();
}, 30_000);

describe("a session in a repo, answered from the tray panel", () => {
  test("a new session asks for approval of a command, and a click in the tray panel lets its agent finish the turn", async () => {
    const page = await trackwall.open();
    await page.keyboard.press("Control+3");
    await page.getByRole("button", { name: "Session in the repo, no task" }).click();
    await waitForTerminal(page, "Welcome to the fake");

    await typeInTerminal(page, "run the tests\r");
    await waitForTerminal(page, "Do you want to run this command?");
    await sessionRow(page, "shop").getByText("asking for approval").waitFor();

    const panel = await openTrayPanel(trackwall, TOKEN);
    const request = panel.getByRole("list", { name: "Waiting for you" });
    await request.getByText("Create a file").waitFor();
    await request.getByText("made-by-agent.txt").waitFor();
    await request.getByRole("button", { name: "Yes", exact: true }).click();

    // The agent goes on and ends its turn; Playwright reports every page as focused, so the main window is in front
    // and the session you are looking at is idle, not waiting for you.
    await panel.getByText("Nothing is waiting for you.").waitFor();
    await sessionRow(page, "shop").getByText("idle", { exact: true }).waitFor();
  }, 60_000);
});
