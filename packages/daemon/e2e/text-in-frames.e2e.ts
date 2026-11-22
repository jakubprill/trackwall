import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { layoutFaults, WIDER_FONT } from "./support/layout-faults.ts";
import { changeSessionLists, SMALL_SCREEN, showHomeOnBar, showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

/** Longer than a tooltip's fade (`transition-opacity`, 150 ms). */
const TOOLTIP_FADE_MS = 300;

/** Faults of layout in the page now (`layoutFaults`), each line prefixed with where the test was. */
async function outside(page: Page, where: string): Promise<string[]> {
  // Away from the button just clicked, whose tooltip lies over the view on purpose while the pointer is on it.
  const size = page.viewportSize();
  if (size === null) throw new Error("the page has no viewport size");
  await page.mouse.move(size.width - 1, size.height - 1);
  await page.waitForTimeout(TOOLTIP_FADE_MS);
  const found = await page.evaluate(layoutFaults, null);
  return found.map((line) => `${where}: ${line}`);
}

describe("text in the UI", () => {
  test("stays inside its buttons, cards and strips in every view, every settings category and the tray panel, with a wider font on a small screen", async () => {
    const page = await trackwall().open(SMALL_SCREEN);
    // Things waiting, a task and a session, so the views show their longest labels: the supervisor waits for the
    // user, which the fake Copilot CLI never does on its own.
    await changeSessionLists(page, (list) => {
      for (const session of list.sessions) if (session.supervisor) session.needsAttention = true;
    });
    await page.addStyleTag({ content: WIDER_FONT });
    await page.getByRole("button", { name: /Pin the supervisor panel open/ }).click();
    await page.getByRole("complementary", { name: "Supervisor" }).getByRole("button", { name: "New conversation" }).click();
    await showSessions(page);
    await page
      .getByRole("textbox", { name: "Prompt for the agent" })
      .fill("Add a discount to the cart for customers who order more than ten items");
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, "--interactive=Add a discount");
    await page.getByRole("button", { name: "New task or Copilot CLI session" }).click();
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    await waitForTerminal(page, "Welcome to the fake");
    await page.getByRole("button", { name: /The supervisor is waiting for you/ }).waitFor();
    // Home has no icon until the user shows it (ADR-294): shown, it is one of the views below too.
    const views = page.getByRole("navigation", { name: "Views" }).getByRole("button");
    expect(await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Home/ }).count()).toBe(0);
    await showHomeOnBar(page);

    const found: string[] = [];
    // By position, named by the label: a view's text can be only a number (a shortcut, a waiting count), which another
    // view's text holds too, such as the "1" of Sessions' shortcut and the "1" waiting in it.
    for (let i = 0; i < (await views.count()); i++) {
      const button = views.nth(i);
      const view = await button.getAttribute("aria-label");
      if (view === null) throw new Error(`view button ${i} has no aria-label`);
      await button.click();
      // A view loads its data after it shows; the network quiets down once it has.
      await page.waitForLoadState("networkidle");
      found.push(...(await outside(page, view)));
    }
    const categories = page.getByRole("navigation", { name: "Settings categories" }).getByRole("button");
    await categories.first().waitFor();
    for (const entry of await categories.allInnerTexts()) {
      // "Get started" has a second line that says what is left to do, which changes once the doctor ran.
      const category = entry.split("\n")[0] ?? entry;
      await categories.filter({ hasText: category }).click();
      await page.waitForLoadState("networkidle");
      found.push(...(await outside(page, `Settings, ${category}`)));
      // A setting is a folded row (ADR-263): its form is checked too, with every row of the category open at once.
      const folded = page.locator('button[aria-expanded="false"][aria-controls]');
      if ((await folded.count()) === 0) continue;
      // An opened row leaves the locator, so the first folded one is always the next.
      while ((await folded.count()) > 0) await folded.first().click();
      await page.waitForLoadState("networkidle");
      found.push(...(await outside(page, `Settings, ${category}, every setting open`)));
    }
    const tray = await trackwall().openTrayPanel();
    await tray.addStyleTag({ content: WIDER_FONT });
    await tray.waitForLoadState("networkidle");
    found.push(...(await outside(tray, "Tray panel")));

    expect(found).toEqual([]);
  }, 120_000);
});
