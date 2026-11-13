import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { sessionRow, showSessions, typeInTerminal, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

function palette(page: Page) {
  return page.getByRole("dialog", { name: "Command palette" });
}

function currentView(page: Page) {
  return page.getByRole("navigation", { name: "Views" }).locator('[aria-current="page"]');
}

/**
 * Types into the palette's field and, once the first command is the one expected (repos come in a moment after the
 * palette opens), picks it with Enter, as the user does.
 */
async function goTo(page: Page, query: string, first: RegExp): Promise<void> {
  await palette(page).getByRole("combobox", { name: "Go to or do" }).fill(query);
  await palette(page).getByRole("option", { selected: true, name: first }).waitFor();
  await page.keyboard.press("Enter");
  await palette(page).waitFor({ state: "detached" });
}

describe("the command palette (ADR-246)", () => {
  test("Ctrl+K goes to a view, a repo and a session by name; in a terminal Ctrl+K stays the terminal's and Ctrl+Shift+K opens it", async () => {
    const page = await trackwall().open();

    await page.keyboard.press("Control+K");
    await expect(palette(page).getByRole("option", { name: /Repos/ }).first().isVisible()).resolves.toBe(true);
    await goTo(page, "flow", /^Views\s*Flow/);
    await expect(currentView(page).getAttribute("aria-label")).resolves.toBe("Flow");

    // Esc closes it without doing anything.
    await page.keyboard.press("Control+K");
    await page.keyboard.press("Escape");
    await palette(page).waitFor({ state: "detached" });
    await expect(currentView(page).getAttribute("aria-label")).resolves.toBe("Flow");

    await page.keyboard.press("Control+K");
    await goTo(page, "shop", /^Repos\s*shop/);
    await expect(currentView(page).getAttribute("aria-label")).resolves.toBe("Repos");

    await showSessions(page);
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    await waitForTerminal(page, "Welcome to the fake");

    // Had Ctrl+K opened the palette, Ctrl+Shift+K would close it again, and nothing would go Home.
    await typeInTerminal(page, "x");
    await page.keyboard.press("Control+K");
    await expect(palette(page).count()).resolves.toBe(0);
    await page.keyboard.press("Control+Shift+K");
    await goTo(page, "home", /^Views\s*Home/);
    await expect(currentView(page).getAttribute("aria-label")).resolves.toBe("Home");

    await page.keyboard.press("Control+K");
    const command = palette(page).getByRole("option", { name: /^Sessions\s*shop/ });
    await command.click();
    await palette(page).waitFor({ state: "detached" });
    await expect(currentView(page).getAttribute("aria-label")).resolves.toMatch(/^Sessions/);
    await sessionRow(page, "shop").first().waitFor();
    await waitForTerminal(page, "Welcome to the fake");
  }, 60_000);

  test("a theme from the palette repaints the window at once", async () => {
    const page = await trackwall().open();
    await page.keyboard.press("Control+K");
    await goTo(page, "theme light", /Theme: Light/);
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");

    await page.keyboard.press("Control+K");
    await expect(
      palette(page)
        .getByRole("option", { name: /Theme: Light/ })
        .count(),
    ).resolves.toBe(0);
    await goTo(page, "theme dark", /Theme: Dark/);
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  }, 60_000);
});
