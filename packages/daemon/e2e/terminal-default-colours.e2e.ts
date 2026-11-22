import { describe, expect, test } from "bun:test";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("a session terminal and Copilot CLI's own default colours", () => {
  test("a new session's terminal keeps the app's transparent background and text colour after Copilot CLI sets GitHub's dark ones (OSC 11, OSC 10)", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    // The fake, like Copilot CLI, sets the background to #0D1117 and the text to #F0F6FC as it starts.
    await waitForTerminal(page, "Welcome to the fake");

    // xterm.js paints the terminal's background on its scrollable element, and its text colour on the rows.
    const colours = await page.evaluate(() => {
      const paint = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`no ${selector} in the session terminal`);
        return getComputedStyle(element);
      };
      return { background: paint(".xterm-scrollable-element").backgroundColor, text: paint(".xterm-rows").color };
    });
    expect(colours.background).toBe("rgba(0, 0, 0, 0)");
    expect(colours.text).not.toBe("rgb(240, 246, 252)");
  }, 60_000);
});
