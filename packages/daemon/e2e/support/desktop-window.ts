import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { z } from "zod";

/**
 * The UI as the Tauri shell shows it, which the daemon's own page does not: the files under the window's origin with
 * the CSP of `tauri.conf.json`, the daemon on another origin (127.0.0.1 and its port), and the connection from the
 * `daemon_connection` command instead of the address. A CSP the UI breaks (code from strings, a socket to the daemon)
 * passes everywhere else and leaves the release window blank. Close to the window, not the same: Tauri adds hashes of
 * its own to the CSP when it builds the app, and macOS serves the window from `tauri://localhost`, which Chromium cannot load.
 */

const TAURI_CONF = join(import.meta.dir, "..", "..", "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json");
const TauriConf = z.object({ app: z.object({ security: z.object({ csp: z.string() }) }) });

/** The window's origin on Windows (WebView2). */
const WINDOW_ORIGIN = "http://tauri.localhost";

/** The window, and what went wrong in it so far: CSP violations, errors nothing caught and errors in the console. */
export interface DesktopWindow {
  page: Page;
  problems: string[];
  close: () => Promise<void>;
  /** Settles with the first frame of the daemon's events socket (`/ws`), the snapshot it sends on connecting. */
  eventsArrived: Promise<void>;
}

export async function openDesktopWindow(
  browser: Browser,
  daemon: { baseUrl: string; token: string },
  viewport: { width: number; height: number },
  /** Files of the UI the window fails to load (a 500), by their path, such as a chunk to show what the UI does without it. */
  failingFiles?: RegExp,
): Promise<DesktopWindow> {
  const csp = TauriConf.parse(JSON.parse(readFileSync(TAURI_CONF, "utf8"))).app.security.csp;
  // Chromium asks before a public page reaches a loopback address, and a page the test serves counts as public; the
  // Tauri window does not ask.
  const context = await browser.newContext({ viewport, colorScheme: "dark", permissions: ["local-network-access"] });
  // The files come from the daemon under test, which serves the built UI, with the window's CSP added.
  await context.route(`${WINDOW_ORIGIN}/**`, async (route) => {
    const { pathname, search } = new URL(route.request().url());
    if (failingFiles?.test(pathname)) return route.fulfill({ status: 500 });
    const response = await route.fetch({ url: `${daemon.baseUrl}${pathname}${search}` });
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
  // React reports an error a boundary caught only in the console.
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  await page.exposeFunction("reportCspViolation", (text: string) => problems.push(`CSP: ${text}`));
  await page.addInitScript(fakeTauri, daemon);
  const eventsArrived = new Promise<void>((arrived) =>
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname === "/ws") socket.once("framereceived", () => arrived());
    }),
  );
  await page.goto(`${WINDOW_ORIGIN}/`);
  return { page, problems, eventsArrived, close: () => context.close() };
}

/**
 * Runs in the page before its scripts: what `@tauri-apps/api` finds in the Tauri window, enough for the UI to start
 * (`daemon_connection` answers, other commands answer nothing, events never come), and every CSP violation reported.
 */
function fakeTauri(daemon: { baseUrl: string; token: string }) {
  type Fake = Record<string, unknown> & { reportCspViolation: (text: string) => void };
  const page = window as unknown as Fake;
  window.addEventListener("securitypolicyviolation", (event) =>
    page.reportCspViolation(`${event.effectiveDirective} refused ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}`),
  );
  let nextId = 1;
  page.isTauri = true;
  page.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  page.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => nextId++,
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
    invoke: async (command: string) => {
      if (command === "daemon_connection") return daemon;
      if (command === "plugin:event|listen") return nextId++;
      return null;
    },
  };
}
