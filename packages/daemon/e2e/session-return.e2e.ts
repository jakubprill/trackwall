import { describe, expect, test } from "bun:test";
import type { WebSocketRoute } from "playwright";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("back in Sessions from another view", () => {
  test("the session terminal shows its last screen while the daemon's screen image is late, and says it is connecting", async () => {
    const page = await trackwall().open();
    // Session terminals go through here; while `holding`, the daemon's answers wait, as behind a daemon whose event
    // loop stands still. A route takes only sockets of a page loaded after it, hence the reload.
    let holding = false;
    const held: Array<{ to: WebSocketRoute; message: string | Buffer }> = [];
    await page.routeWebSocket(/\/ws\/pty\//, (socket) => {
      socket.connectToServer().onMessage((message) => {
        if (holding) held.push({ to: socket, message });
        else socket.send(message);
      });
    });
    await page.reload();
    await showSessions(page);
    await page.getByRole("checkbox", { name: "In its own worktree" }).uncheck();
    await page.getByRole("button", { name: "Start session" }).click();
    await waitForTerminal(page, "Welcome to the fake");

    holding = true;
    await page
      .getByRole("navigation", { name: "Views" })
      .getByRole("button", { name: /^Repos/ })
      .click();
    await showSessions(page);
    const connecting = page.getByText("Connecting to the session…");
    await connecting.waitFor();
    await waitForTerminal(page, "Welcome to the fake");
    expect(held.length).toBeGreaterThan(0);

    holding = false;
    for (const { to, message } of held) to.send(message);
    await connecting.waitFor({ state: "detached" });
    await waitForTerminal(page, "Welcome to the fake");
  }, 60_000);
});
