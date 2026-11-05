import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

/** The background xterm.js paints under ANSI black, which Copilot CLI uses for its prompt box and the user's messages. */
async function ansiBlackBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rules = [...document.querySelectorAll(".xterm style")].map((style) => style.textContent ?? "").join("\n");
    const match = /\.xterm-bg-0 \{ background-color: ([^;]+);/.exec(rules);
    if (!match?.[1]) throw new Error(`no rule for ANSI black among the terminal's styles:\n${rules}`);
    return match[1];
  });
}

describe("a session terminal in a window with a background effect", () => {
  test("follows the window effect that the desktop shell sets after the page has loaded, with translucent colours", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    await waitForTerminal(page, "Welcome to the fake");
    const opaque = await ansiBlackBackground(page);

    // What the shell does once the page has loaded (ADR-11), here after the terminal has opened.
    await page.evaluate(() => document.documentElement.setAttribute("data-window-effect", "mica"));
    await page.waitForFunction((before) => {
      const style = [...document.querySelectorAll(".xterm style")].map((element) => element.textContent).join("\n");
      return !style.includes(`.xterm-bg-0 { background-color: ${before};`);
    }, opaque);
    // xterm.js writes the colour as hex: `--secondary` at the effect's 60% fill alpha (0x99), not its own opaque grey.
    expect(await ansiBlackBackground(page)).toMatch(/^#[0-9a-f]{6}99$/);

    await page.evaluate(() => document.documentElement.removeAttribute("data-window-effect"));
    await page.waitForFunction(() => {
      const style = [...document.querySelectorAll(".xterm style")].map((element) => element.textContent).join("\n");
      return /\.xterm-bg-0 \{ background-color: #[0-9a-f]{6}(ff)?;/.test(style);
    });
  }, 60_000);
});
