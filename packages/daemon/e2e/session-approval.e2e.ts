import { afterAll, beforeAll, describe, test } from "bun:test";
import { sessionRow, showSessions, startTrackwall, type Trackwall, typeInTerminal, waitForTerminal } from "./support/trackwall-ui.ts";

// Unset when the start failed, so `afterAll` stops only what started.
let trackwall: Trackwall | undefined;

// A limit above the default 5 s: Chromium and the daemon start slowly on a Windows runner.
beforeAll(async () => {
  trackwall = await startTrackwall();
}, 60_000);

afterAll(async () => {
  await trackwall?.stop();
}, 30_000);

describe("a session in a repo, answered from the tray panel", () => {
  test("a new session asks for approval of a command, and a click in the tray panel lets its agent finish the turn", async () => {
    if (trackwall === undefined) throw new Error("Trackwall did not start");
    const page = await trackwall.open();
    await showSessions(page);
    await page.getByRole("button", { name: "Session in the repo, no task" }).click();

    await typeInTerminal(page, "run the tests\r");
    await waitForTerminal(page, "Do you want to run this command?");
    await sessionRow(page, "shop").getByText("asking for approval").waitFor();

    const panel = await trackwall.openTrayPanel();
    const waiting = panel.getByRole("list", { name: "Waiting for you" });
    await waiting.getByText("Create a file").waitFor();
    await waiting.getByText("made-by-agent.txt").waitFor();
    await waiting.getByRole("button", { name: "Yes", exact: true }).click();

    // The agent goes on and ends its turn (the fake goes on only after a key of a "Yes" option). Playwright reports every page as focused, so the main window is in front
    // and the session the user is looking at is idle, not waiting for them.
    await panel.getByText("Nothing is waiting for you.").waitFor();
    await sessionRow(page, "shop").getByText("idle", { exact: true }).waitFor();
  }, 60_000);
});
