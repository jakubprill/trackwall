import type { Client } from "@modelcontextprotocol/client";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { newToken } from "../../src/infra/discovery.ts";
import { connectSessionClient } from "../../test/support/mcp-client.ts";
import { ONE_REPO, type SessionApiOptions, startSessionApi } from "../../test/support/session-api.ts";
import { UI_DIR } from "./ui-dir.ts";

const VIEWPORT = { width: 1600, height: 1000 };
const TRAY_PANEL_VIEWPORT = { width: 340, height: 420 };
const TERMINAL_TIMEOUT_MS = 20_000;
/** xterm.js draws a space in a row as a no-break space. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/**
 * The daemon of `test/support/session-api.ts` (a real facade, PTY and git, the fake Copilot CLI) serving the built UI,
 * and Chromium from Playwright to look at it (ADR-71). `agentOf` is the MCP client a session's agent has through its
 * bridge. `stop` closes the clients and the browser, then the daemon, also when one of them fails.
 */
export async function startTrackwall(options: Omit<SessionApiOptions, "uiDir"> = ONE_REPO) {
  const token = newToken();
  const browser = await chromium.launch();
  const daemon = await startSessionApi(token, { ...options, uiDir: UI_DIR }).catch(async (err: unknown) => {
    await browser.close();
    throw err;
  });
  const origin = `http://127.0.0.1:${daemon.api.port}`;
  const clients: Client[] = [];
  return {
    daemon,
    /** The main window as the Tauri shell opens it, on Home. */
    open: () => openMainWindow(browser, origin, token),
    /** The tray panel (ADR-50): the same UI under `#tray-panel`, at the size of its window. */
    openTrayPanel: () => openTrayPanel(browser, origin, token),
    agentOf: async (session: string) => {
      const client = await connectSessionClient(daemon.api.port, token, daemon.home, session);
      clients.push(client);
      return client;
    },
    stop: async () => {
      try {
        for (const client of clients) await client.close();
        await browser.close();
      } finally {
        await daemon.stop();
      }
    },
  };
}

export type Trackwall = Awaited<ReturnType<typeof startTrackwall>>;

/** Loads the UI with the token in the address, as the daemon prints it, and waits until the UI has taken it from there. */
async function signIn(page: Page, origin: string, token: string): Promise<void> {
  await page.goto(`${origin}/#token=${token}`);
  await page.waitForFunction(() => !window.location.hash.includes("token="));
}

/**
 * The main window. The supervisor's panel is folded, so a session terminal is wider than the screen the fake Copilot
 * CLI draws: the fake does not redraw when the terminal shrinks, as Copilot CLI does, and its approval dialog wrapped
 * over two rows is no dialog the daemon can read.
 */
async function openMainWindow(browser: Browser, origin: string, token: string): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: "dark" });
  await signIn(page, origin, token);
  await page.getByRole("button", { name: "Fold the supervisor panel" }).click();
  return page;
}

/**
 * The tray panel reads the connection from the tab's storage, so after signing in the tab loads the panel's address,
 * with another query string so that the browser loads the page again instead of only changing the fragment.
 */
async function openTrayPanel(browser: Browser, origin: string, token: string): Promise<Page> {
  const page = await browser.newPage({ viewport: TRAY_PANEL_VIEWPORT, colorScheme: "dark" });
  await signIn(page, origin, token);
  await page.goto(`${origin}/?panel#tray-panel`);
  return page;
}

/** Opens the Sessions view from the view bar, as the user clicks it (its label carries the waiting count). */
export async function showSessions(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("button", { name: /^Sessions/ })
    .click();
}

/** The list on the left of the Sessions view. */
export function sessionList(page: Page): Locator {
  return page.getByRole("navigation", { name: "Session list" });
}

/** The row of a session or task in the Sessions list, by the repo it works in. */
export function sessionRow(page: Page, repo: string): Locator {
  return sessionList(page).getByRole("button").filter({ hasText: repo });
}

/** Whether the session terminal shows `expected`, read in the page from the rows xterm.js draws. */
function terminalShows([expected, noBreakSpace]: [string, string]): boolean {
  const rows = Array.from(document.querySelectorAll(".xterm-rows > div"), (row) => (row.textContent ?? "").replaceAll(noBreakSpace, " "));
  return rows.join("\n").includes(expected);
}

/** Waits until the session terminal shows `text`; the error says what it showed instead. */
export async function waitForTerminal(page: Page, text: string): Promise<void> {
  try {
    const shows: [string, string] = [text, NO_BREAK_SPACE];
    await page.waitForFunction(terminalShows, shows, { timeout: TERMINAL_TIMEOUT_MS });
  } catch (err) {
    const shown = (await page.locator(".xterm-rows > div").allTextContents()).join("\n");
    throw new Error(`the terminal did not show "${text}"; it shows:\n${shown}`, { cause: err });
  }
}

/**
 * Types into the session terminal as the user does: a click to focus it, then the keys. First it waits for the
 * terminal to draw the session's screen (the fake's welcome line is its first), which comes over its socket once it is
 * open: a terminal just mounted (after switching tabs) drops keys until then.
 */
export async function typeInTerminal(page: Page, keys: string): Promise<void> {
  await waitForTerminal(page, "Welcome to the fake");
  await page.locator(".xterm").click();
  await page.keyboard.type(keys);
}
