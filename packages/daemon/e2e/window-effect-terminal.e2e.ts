import { describe, expect, test } from "bun:test";
import type { CDPSession, Page } from "playwright";
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

/**
 * The system's "Reduce transparency" as the page sees it. Playwright has no option for it, so through CDP, with one CDP
 * session per page kept open: an override ends with the session that set it. It is set either way, because the host's
 * setting decides otherwise: GitHub's macOS runners turn it on, and Chromium follows it, so the page there keeps its
 * surfaces opaque even with a window effect (`index.css`).
 */
async function reduceTransparency(page: Page, value: "reduce" | "no-preference"): Promise<void> {
  let cdp = cdpSessions.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    cdpSessions.set(page, cdp);
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value }] });
  const matches = await page.evaluate((query) => matchMedia(query).matches, `(prefers-reduced-transparency: ${value})`);
  if (!matches) throw new Error(`Chromium did not take prefers-reduced-transparency: ${value}`);
}

const cdpSessions = new WeakMap<Page, CDPSession>();

/** Sets or removes the window effect on `<html>`, as the desktop shell does once the page has loaded (ADR-11). */
async function windowEffect(page: Page, effect: string | undefined): Promise<void> {
  await page.evaluate((value) => {
    if (value === undefined) document.documentElement.removeAttribute("data-window-effect");
    else document.documentElement.setAttribute("data-window-effect", value);
  }, effect);
}

describe("a session terminal in a window with a background effect", () => {
  test("follows the window effect that the desktop shell sets after the page has loaded, with translucent colours unless the system reduces transparency", async () => {
    const page = await trackwall().open();
    await reduceTransparency(page, "reduce");
    await showSessions(page);
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    await waitForTerminal(page, "Welcome to the fake");
    const opaque = await ansiBlackBackground(page);
    expect(opaque).toMatch(/^#[0-9a-f]{6}(ff)?$/);

    // With "Reduce transparency" the effect leaves the tokens opaque. No wait: the terminal reads its theme again in the
    // attribute's mutation observer, a microtask that runs before `evaluate` returns, and xterm.js rewrites its styles then.
    await windowEffect(page, "mica");
    expect(await ansiBlackBackground(page)).toBe(opaque);

    // Without it, here after the terminal has opened.
    await windowEffect(page, undefined);
    await reduceTransparency(page, "no-preference");
    await windowEffect(page, "mica");
    await page.waitForFunction((before) => {
      const style = [...document.querySelectorAll(".xterm style")].map((element) => element.textContent).join("\n");
      return !style.includes(`.xterm-bg-0 { background-color: ${before};`);
    }, opaque);
    // xterm.js writes the colour as hex: `--secondary` at the effect's 60% fill alpha (0x99), not its own opaque grey.
    expect(await ansiBlackBackground(page)).toMatch(/^#[0-9a-f]{6}99$/);

    await windowEffect(page, undefined);
    await page.waitForFunction(() => {
      const style = [...document.querySelectorAll(".xterm style")].map((element) => element.textContent).join("\n");
      return /\.xterm-bg-0 \{ background-color: #[0-9a-f]{6}(ff)?;/.test(style);
    });
    expect(await ansiBlackBackground(page)).toBe(opaque);
  }, 60_000);
});
