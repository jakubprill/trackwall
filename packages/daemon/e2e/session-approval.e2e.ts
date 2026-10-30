import { describe, test } from "bun:test";
import { sessionRow, showSessions, typeInTerminal, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("a session in a repo, answered from the tray panel", () => {
  test("a new session asks for approval of a command, and a click in the tray panel lets its agent finish the turn", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();

    await typeInTerminal(page, "run the tests\r");
    await waitForTerminal(page, "Do you want to run this command?");
    await sessionRow(page, "shop").getByText("asking for approval").waitFor();
    // A browser tab counts what waits for you in its title, where the tray would in the desktop app.
    await page.waitForFunction(() => document.title === "(1) Trackwall");

    const panel = await trackwall().openTrayPanel();
    const waiting = panel.getByRole("list", { name: "Waiting for you" });
    await waiting.getByText("Create a file").waitFor();
    await waiting.getByText("made-by-agent.txt").waitFor();
    await waiting.getByRole("button", { name: "Yes", exact: true }).click();

    // The agent goes on and ends its turn (the fake goes on only after a key of a "Yes" option). Playwright reports every page as focused, so the main window is in front
    // and the session the user is looking at is idle, not waiting for them.
    await panel.getByText("Nothing is waiting for you.").waitFor();
    await sessionRow(page, "shop").getByText("idle", { exact: true }).waitFor();
    await page.waitForFunction(() => document.title === "Trackwall");
  }, 60_000);
});
