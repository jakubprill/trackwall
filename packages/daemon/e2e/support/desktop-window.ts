import { readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { UI_DIR } from "./ui-dir.ts";

/**
 * The UI as the Tauri shell shows it, which the daemon's own page does not: the files under the window's origin with
 * the CSP of `tauri.conf.json`, the daemon on another origin (127.0.0.1 and its port), and the connection from the
 * `daemon_connection` command instead of the address. A CSP the UI breaks (code from strings, a socket to the daemon)
 * passes everywhere else and leaves the release window blank.
 */

const TAURI_CONF = join(import.meta.dir, "..", "..", "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json");
const TauriConf = z.object({ app: z.object({ security: z.object({ csp: z.string() }) }) });

/** The window's origin on Windows (WebView2). On macOS it is `tauri://localhost`, a scheme Chromium cannot load. */
const WINDOW_ORIGIN = "http://tauri.localhost";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

/** The window, and what went wrong in it so far: CSP violations and errors nothing caught. */
export interface DesktopWindow {
  page: Page;
  problems: string[];
  /** Settles with the first frame of the daemon's events socket (`/ws`), the snapshot it sends on connecting. */
  eventsArrived: Promise<void>;
}

export async function openDesktopWindow(
  browser: Browser,
  daemon: { baseUrl: string; token: string },
  viewport: { width: number; height: number },
): Promise<DesktopWindow> {
  const csp = TauriConf.parse(JSON.parse(readFileSync(TAURI_CONF, "utf8"))).app.security.csp;
  // Chromium asks before a public page reaches a loopback address, and a page the test serves counts as public; the
  // Tauri window does not ask.
  const context = await browser.newContext({ viewport, colorScheme: "dark", permissions: ["local-network-access"] });
  await context.route(`${WINDOW_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = resolve(UI_DIR, `.${path === "/" ? "/index.html" : path}`);
    if (relative(UI_DIR, file).startsWith("..")) return route.fulfill({ status: 404 });
    const body = readFileSync(file);
    const contentType = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    await route.fulfill({ status: 200, body, headers: { "content-type": contentType, "content-security-policy": csp } });
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
  await page.exposeFunction("reportCspViolation", (text: string) => problems.push(`CSP: ${text}`));
  await page.addInitScript(fakeTauri, daemon);
  const eventsArrived = new Promise<void>((arrived) =>
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname === "/ws") socket.once("framereceived", () => arrived());
    }),
  );
  await page.goto(`${WINDOW_ORIGIN}/`);
  return { page, problems, eventsArrived };
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
