// The screenshots of the documentation site, taken from the demo daemon (`packages/daemon/scripts/demo.ts`): a
// made-up shop of twenty repos with sessions, proposals, agent tasks and running services. Run it again after a
// change to a view the pages show:
//
//   pnpm --filter @trackwall/ui build && pnpm --filter @trackwall/docs screenshots
//
// It needs Chromium for Playwright (`pnpm --filter @trackwall/docs exec playwright install chromium`) and `mise` on
// PATH for the services. The images go to `apps/docs/public/screenshots/`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const OUT = join(REPO, "apps", "docs", "public", "screenshots");
const HOME = join(tmpdir(), "trackwall-demo");
const VIEWPORT = { width: 1600, height: 1000 };
const DEMO_READY_MS = 180_000;

async function startDemo(): Promise<{ url: string; stop: () => void }> {
  rmSync(HOME, { recursive: true, force: true });
  const demo = spawn(process.execPath, [join(REPO, "packages", "daemon", "scripts", "demo.ts"), HOME], { stdio: "inherit" });
  const daemonFile = join(HOME, "daemon.json");
  const deadline = Date.now() + DEMO_READY_MS;
  while (!existsSync(daemonFile)) {
    if (demo.exitCode !== null) throw new Error(`the demo daemon ended with ${demo.exitCode}`);
    if (Date.now() > deadline) throw new Error("the demo daemon did not get ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const file: unknown = JSON.parse(readFileSync(daemonFile, "utf8"));
  const port = typeof file === "object" && file !== null ? Reflect.get(file, "port") : undefined;
  const token = typeof file === "object" && file !== null ? Reflect.get(file, "token") : undefined;
  if (typeof port !== "number" || typeof token !== "string") throw new Error(`${daemonFile} has no port and token`);
  return { url: `http://127.0.0.1:${port}/#token=${token}`, stop: () => demo.kill("SIGINT") };
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
    await page.getByText("3 task proposals").click();
    await settle(page);
  },
  tasks: async (page) => {
    await page.keyboard.press("Control+3");
    await page.getByText("pricing", { exact: true }).first().click();
    await settle(page);
  },
  overview: async (page) => {
    // The graph of twenty repos is wider than the other views.
    await page.setViewportSize({ width: 2400, height: 760 });
    await page.keyboard.press("Control+4");
    await settle(page);
    await page.getByText("orders-api", { exact: true }).first().click();
    await settle(page);
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
  </style>${window(left, "left: 40px; top: 70px;")}${window(right, "left: 920px; top: 150px;")}`);
  await shot(page, "windows");
}

mkdirSync(OUT, { recursive: true });
const demo = await startDemo();
const browser = await chromium.launch();
try {
  for (const [name, show] of Object.entries(SHOTS)) {
    const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: "dark" });
    await page.goto(demo.url);
    await settle(page, 2500);
    await show(page);
    await shot(page, name);
    await page.close();
  }
  await windowsShot(await browser.newPage(), join(OUT, "sessions-grid.png"), join(OUT, "overview.png"));
} finally {
  await browser.close();
  demo.stop();
}
