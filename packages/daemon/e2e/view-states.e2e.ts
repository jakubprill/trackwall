import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { layoutFaults, WIDER_FONT } from "./support/layout-faults.ts";
import { GALLERY_DIR } from "./support/ui-dir.ts";

/** Where the page loads the gallery from; the test answers every request to it from the built files. */
const ORIGIN = "http://gallery.test";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

/** The built gallery of view states (`packages/ui/gallery.html`), served from its files, without a daemon. */
async function openGallery(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = join(GALLERY_DIR, path);
    return route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
  });
  await page.goto(`${ORIGIN}/gallery.html`);
  await page.locator("[data-gallery-frame]").first().waitFor();
  if (errors.length > 0) throw new Error(`the gallery failed: ${errors.join("; ")}`);
  return page;
}

describe("the gallery of view states", () => {
  test("draws every state of every part with nothing out of its frame, cut off, over other text or painted over, in both themes and with a wider font", async () => {
    const page = await openGallery();
    const frames = await page
      .locator("[data-gallery-frame]")
      .evaluateAll((all) => all.map((f) => f.getAttribute("data-gallery-frame") ?? ""));

    const found: string[] = [];
    for (const frame of frames) {
      const faults = await page.evaluate(layoutFaults, `[data-gallery-frame="${frame}"] > [data-gallery-content]`);
      found.push(...faults.map((fault) => `${frame}: ${fault}`));
    }

    expect(frames.length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  }, 120_000);

  test("draws its wider font with the letter spacing the other E2E tests use for it", async () => {
    const page = await openGallery();
    const spacing = await page
      .locator(".gallery-wide-font")
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return Number.parseFloat(style.letterSpacing) / Number.parseFloat(style.fontSize);
      });

    expect(`body { letter-spacing: ${spacing.toFixed(2)}em; }`).toBe(WIDER_FONT);
  }, 60_000);
});
