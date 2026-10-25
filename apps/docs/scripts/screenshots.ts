// The screenshots of the documentation site, taken from the demo daemon (`packages/daemon/scripts/demo.ts`): a
// made-up shop of twenty repos with sessions, proposals, agent tasks and running services. Run it again after a
// change to a view the pages show:
//
//   pnpm --filter @trackwall/ui build && pnpm --filter @trackwall/docs screenshots
//
// Names of pictures after the command (`… screenshots task-review`) take only those, and not the two-window picture;
// `tray-panel` is the tray panel at the size of its window.
//
// It needs Chromium for Playwright (`pnpm --filter @trackwall/docs exec playwright install chromium`) and `mise` on
// PATH for the services. The images go to `apps/docs/public/screenshots/`.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_FILE, DaemonFile } from "@trackwall/protocol";
import { chromium, type Page } from "playwright";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const OUT = join(REPO, "apps", "docs", "public", "screenshots");
// A short path with no user name in it: the Repos view shows where the projects folder is.
const HOME = process.platform === "win32" ? join(parse(tmpdir()).root, "trackwall-demo") : join("/tmp", "trackwall-demo");
const VIEWPORT = { width: 1600, height: 1000 };
const DEMO_READY_MS = 180_000;
const DEMO_STOP_MS = 30_000;

/** Waits until the demo daemon has set its scene and written `daemon.json`. */
async function demoReady(demo: ChildProcess): Promise<DaemonFile> {
  const daemonFile = join(HOME, DAEMON_FILE);
  const deadline = Date.now() + DEMO_READY_MS;
  while (!existsSync(daemonFile)) {
    if (demo.exitCode !== null) throw new Error(`the demo daemon ended with ${demo.exitCode}`);
    if (Date.now() > deadline) throw new Error("the demo daemon did not get ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const parsed = DaemonFile.safeParse(JSON.parse(readFileSync(daemonFile, "utf8")));
  if (!parsed.success) throw new Error(`${daemonFile} is not a daemon file: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Stops the demo through its API, so it stops its services and sessions itself: on Windows a signal to the child
 * would end it at once. A demo that never got ready, or does not answer, is killed.
 */
async function stopDemo(demo: ChildProcess, daemon: DaemonFile | undefined): Promise<void> {
  if (demo.exitCode !== null) return;
  const exited = once(demo, "exit", { signal: AbortSignal.timeout(DEMO_STOP_MS) });
  if (daemon === undefined) demo.kill();
  else {
    const origin = `http://127.0.0.1:${daemon.port}`;
    const headers = { authorization: `Bearer ${daemon.token}`, origin, "content-type": "application/json" };
    // node:http, not fetch: Bun's fetch sends 127.0.0.1 through HTTP_PROXY.
    const req = request(`${origin}/api/daemon/shutdown`, { method: "POST", headers });
    req.on("error", () => demo.kill());
    req.end("{}");
  }
  await exited.catch(() => demo.kill("SIGKILL"));
}

/** Lets the view load and animate before the picture. */
const settle = (page: Page, ms = 1500) => page.waitForTimeout(ms);

async function shot(page: Page, name: string): Promise<string> {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  console.log(`wrote ${path}`);
  return path;
}

/** One view of the demo per picture, each from a fresh page so no selection carries over. */
const SHOTS: Record<string, (page: Page) => Promise<void>> = {
  home: (page) => settle(page, 4000),
  "sessions-grid": async (page) => {
    await page.keyboard.press("Control+3");
    await page.getByText("Auto", { exact: true }).click();
    await settle(page, 2500);
  },
  "main-session": async (page) => {
    await page.keyboard.press("Control+3");
    await page.getByText("2 task proposals").click();
    await settle(page);
  },
  "task-messages": async (page) => {
    await page.keyboard.press("Control+3");
    await page.getByText("Tell the customer about a retried payment").first().click();
    await settle(page);
  },
  tasks: async (page) => {
    await page.keyboard.press("Control+3");
    await page.getByText("pricing", { exact: true }).first().click();
    await settle(page);
  },
  "task-review": async (page) => {
    await page.keyboard.press("Control+3");
    await page.getByText("pricing", { exact: true }).first().click();
    await page.getByRole("tab", { name: "Changes" }).click();
    await settle(page);
    // A comment on the diff line that contains `code`; the last one stays open in its form.
    const comment = async (code: string, text: string, add: boolean) => {
      await page.locator("pre div", { hasText: code }).first().getByRole("button").click();
      await page.getByRole("textbox", { name: /^Comment on line/ }).fill(text);
      if (add) await page.getByRole("button", { name: "Add comment" }).click();
    };
    await comment("HALF_EVEN", "Round half up: the shop shows 2.345 as 2.35 everywhere else.", true);
    await comment("record PriceChangedEvent", "Add the old price too, so listeners can tell a raise from a cut.", true);
    await comment("publishEvent", "Publish only when the price really changed.", false);
    await settle(page, 500);
  },
  overview: async (page) => {
    // The graph of twenty repos is wider than the other views.
    await page.setViewportSize({ width: 2400, height: 420 });
    await page.keyboard.press("Control+4");
    await settle(page, 3000);
  },
  repos: async (page) => {
    await page.keyboard.press("Control+2");
    await page.getByText("orders-api", { exact: true }).first().click();
    await page.getByRole("tab", { name: "Changes" }).click();
    await settle(page);
  },
  "repo-card": async (page) => {
    await page.keyboard.press("Control+2");
    await page.getByText("orders-api", { exact: true }).first().click();
    await page.getByRole("tab", { name: "Card" }).click();
    await settle(page);
  },
  "mise-tasks": async (page) => {
    await page.keyboard.press("Control+2");
    await page.getByText("admin-bff", { exact: true }).first().click();
    await page.getByRole("tab", { name: "mise tasks" }).click();
    await settle(page);
    // The log of `dev` shows the service's own lines.
    await page.getByRole("listitem").filter({ hasText: "Run locally" }).getByRole("button", { name: "Log" }).click();
    await settle(page, 2500);
  },
};

/**
 * The tray panel at the size of its window (`tauri.conf.json`), with the approvals of the demo's sessions. The page is
 * the same UI under `#tray-panel`; the first load takes the token from the address into the tab's storage.
 */
async function trayPanelShot(page: Page, url: string, origin: string): Promise<void> {
  await page.goto(url);
  // The UI moves the token from the address into the tab's storage once it has loaded.
  await page.waitForFunction(() => window.sessionStorage.length > 0);
  // Another query string, so the browser loads the page again instead of only changing the fragment.
  await page.goto(`${origin}/?panel#tray-panel`);
  await page.getByText("Do you want to run this command?").first().waitFor();
  await settle(page);
  await shot(page, "tray-panel");
}

/** Two Trackwall windows side by side on a desktop, as on a wide monitor: sessions in one, the graph in the other. */
async function windowsShot(page: Page, left: string, right: string): Promise<void> {
  const image = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;
  const window = (path: string, style: string) =>
    `<div class="window" style="${style}"><div class="bar"><i></i><i></i><i></i><span>Trackwall</span></div><img src="${image(path)}"></div>`;
  await page.setViewportSize({ width: 2200, height: 920 });
  await page.setContent(`<style>
    body { margin: 0; height: 100vh; background: radial-gradient(circle at 30% 20%, #16303a, #07090c 70%); overflow: hidden; }
    .window { position: absolute; width: 1240px; border-radius: 10px; overflow: hidden; box-shadow: 0 30px 80px #000c; border: 1px solid #ffffff1f; }
    .bar { height: 30px; background: #11161c; display: flex; align-items: center; gap: 8px; padding: 0 12px; font: 13px system-ui; color: #9aa4ad; }
    .bar i { width: 11px; height: 11px; border-radius: 50%; background: #3a434c; }
    .bar span { margin-left: 8px; }
    img { display: block; width: 100%; }
  </style>${window(left, "left: 40px; top: 70px;")}${window(right, "left: 920px; top: 420px;")}`);
  await shot(page, "windows");
}

mkdirSync(OUT, { recursive: true });
rmSync(HOME, { recursive: true, force: true });
const demo = spawn(process.execPath, [join(REPO, "packages", "daemon", "scripts", "demo.ts"), HOME], { stdio: "inherit" });
let daemon: DaemonFile | undefined;
try {
  daemon = await demoReady(demo);
  const url = `http://127.0.0.1:${daemon.port}/#token=${daemon.token}`;
  const browser = await chromium.launch();
  try {
    const only = process.argv.slice(2);
    for (const [name, show] of Object.entries(SHOTS).filter(([name]) => only.length === 0 || only.includes(name))) {
      const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: "dark" });
      await page.goto(url);
      // The supervisor's panel is folded to its strip, so the view gets the width; the supervisor has a page of its own.
      await page.getByRole("button", { name: "Fold the supervisor panel" }).click();
      await settle(page, 2500);
      await show(page);
      await shot(page, name);
      await page.close();
    }
    if (only.length === 0 || only.includes("tray-panel")) {
      const page = await browser.newPage({ viewport: { width: 340, height: 420 }, deviceScaleFactor: 2, colorScheme: "dark" });
      await trayPanelShot(page, url, `http://127.0.0.1:${daemon.port}`);
      await page.close();
    }
    if (only.length === 0) await windowsShot(await browser.newPage(), join(OUT, "sessions-grid.png"), join(OUT, "overview.png"));
  } finally {
    await browser.close();
  }
} finally {
  await stopDemo(demo, daemon);
}
