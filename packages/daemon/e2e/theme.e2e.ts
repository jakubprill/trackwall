import { describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

/** The relative luminance (0 black, 1 white) of an element's background, as the browser paints the colour. */
async function backgroundLuminance(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no 2D canvas");
    context.fillStyle = getComputedStyle(node).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    const channel = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  });
}

async function theme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

async function chooseTheme(page: Page, label: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("button", { name: /^Settings/ })
    .click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "App" }).click();
  await page
    .getByRole("group", { name: "Theme" })
    .getByRole("radio", { name: new RegExp(`^${label}`) })
    .check();
}

describe("the theme (ADR-235)", () => {
  test("Light repaints the window but keeps the session terminal dark, and the system's theme follows the system live and after a reload", async () => {
    const page = await trackwall().open();
    expect(await theme(page)).toBe("dark");
    expect(await backgroundLuminance(page.locator("body"))).toBeLessThan(0.05);

    await showSessions(page);
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    await waitForTerminal(page, "Welcome to the fake");

    await chooseTheme(page, "Light");
    expect(await theme(page)).toBe("light");
    expect(await backgroundLuminance(page.locator("body"))).toBeGreaterThan(0.8);

    await showSessions(page);
    await waitForTerminal(page, "Welcome to the fake");
    const island = page.locator('[data-theme="dark"]').filter({ has: page.locator(".xterm") });
    expect(await backgroundLuminance(island)).toBeLessThan(0.05);

    await chooseTheme(page, "Same as the system");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");

    await page.reload();
    expect(await theme(page)).toBe("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  }, 60_000);
});
