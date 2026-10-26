import { join } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { ONE_REPO, startSessionApi } from "../../test/support/session-api.ts";

const UI_DIR = join(import.meta.dir, "..", "..", "..", "ui", "dist");
const VIEWPORT = { width: 1600, height: 1000 };

type DaemonOptions = NonNullable<Parameters<typeof startSessionApi>[1]>;

/**
 * The daemon of `test/support/session-api.ts` (a real facade, PTY and git, the fake Copilot CLI) serving the built UI
 * (`packages/ui/dist`, which `pnpm test:e2e` builds first), and Chromium from Playwright to look at it (ADR-70).
 * `stop` closes the browser before the daemon, so no page keeps a socket to a closing API.
 */
export async function startTrackwall(token: string, options: Omit<DaemonOptions, "uiDir"> = ONE_REPO) {
  const daemon = await startSessionApi(token, { ...options, uiDir: UI_DIR });
  const browser = await chromium.launch();
  const origin = `http://127.0.0.1:${daemon.api.port}`;
  const stop = async () => {
    await browser.close();
    await daemon.stop();
  };
  return { daemon, browser, origin, stop, open: () => openMainWindow(browser, origin, token) };
}

/**
 * The main window as the Tauri shell opens it: the address carries the token, which the UI moves into the tab's
 * storage. The supervisor's panel is folded, so a session terminal is wider than the screen the fake Copilot CLI
 * draws: the fake does not redraw when the terminal shrinks, as Copilot CLI does, and its approval dialog wrapped
 * over two rows is no dialog the daemon can read.
 */
async function openMainWindow(browser: Browser, origin: string, token: string): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: "dark" });
  await page.goto(`${origin}/#token=${token}`);
  await page.waitForFunction(() => window.sessionStorage.length > 0);
  await page.getByRole("button", { name: "Fold the supervisor panel" }).click();
  return page;
}

/**
 * The tray panel (ADR-50) in a tab of its own: the same UI under `#tray-panel`. It reads the connection from the tab's
 * storage, so the first load takes the token from the address and a second one, with another query string so that
 * the browser loads the page again, opens the panel.
 */
export async function openTrayPanel(trackwall: Trackwall, token: string): Promise<Page> {
  const page = await trackwall.browser.newPage({ viewport: { width: 340, height: 420 }, colorScheme: "dark" });
  await page.goto(`${trackwall.origin}/#token=${token}`);
  await page.waitForFunction(() => window.sessionStorage.length > 0);
  await page.goto(`${trackwall.origin}/?panel#tray-panel`);
  return page;
}

/** The text of the session terminal, as xterm.js draws it in the page: its rows without the spaces that pad them. */
async function terminalText(page: Page): Promise<string> {
  const rows = await page.locator(".xterm-rows > div").allInnerTexts();
  return rows.map((row) => row.replaceAll("\u00a0", " ").trimEnd()).join("\n");
}

/** Waits until the session terminal shows `text`; the error names what the terminal showed instead. */
export async function waitForTerminal(page: Page, text: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const shown = await terminalText(page);
    if (shown.includes(text)) return;
    if (Date.now() > until) throw new Error(`the terminal did not show "${text}"; it shows:\n${shown}`);
    await page.waitForTimeout(100);
  }
}

/** Types into the session terminal as the user does: a click to focus it, then the keys. */
export async function typeInTerminal(page: Page, keys: string): Promise<void> {
  await page.locator(".xterm").click();
  await page.keyboard.type(keys);
}

/** The row of an entry in the Sessions list, by the repo it works in. */
export function sessionRow(page: Page, repo: string): Locator {
  return page.getByRole("navigation", { name: "Session list" }).getByRole("button").filter({ hasText: repo });
}

export type Trackwall = Awaited<ReturnType<typeof startTrackwall>>;
