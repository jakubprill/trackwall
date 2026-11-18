import { describe, expect, test } from "bun:test";
import { ONE_REPO } from "../test/support/session-api.ts";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const PROMPT = "Add a discount to the cart";

const trackwall = useTrackwall(ONE_REPO);

describe("the More menu of a task's header", () => {
  test("the header shows Verify, VS Code, More and Stop, and More holds the rest by name until Escape, a click outside or an action closes it", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill(PROMPT);
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, `--interactive=${PROMPT}`);

    const header = page.locator("header").filter({ has: page.getByRole("button", { name: "Verify" }) });
    const shown = await header.getByRole("button").filter({ visible: true }).allInnerTexts();
    expect(shown.map((name) => name.trim())).toEqual(["Verify", "VS Code", "More", "Stop"]);

    const more = header.getByRole("button", { name: "More", exact: true });
    const menu = page.getByRole("group", { name: "More task actions" });
    await more.click();
    const items = await menu.getByRole("button").filter({ visible: true }).allInnerTexts();
    expect(items.map((name) => name.trim())).toEqual(["More", "Copy included files", "Change model", "Hand to supervisor", "Pause"]);

    await page.keyboard.press("Escape");
    await menu.getByRole("button", { name: "Pause" }).waitFor({ state: "hidden" });
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("More");

    // A click on the terminal, which keeps its pointer events to itself, closes the menu too.
    await more.click();
    await page.locator(".xterm").first().click();
    await menu.getByRole("button", { name: "Pause" }).waitFor({ state: "hidden" });

    await more.click();
    await menu.getByRole("button", { name: "Change model" }).click();
    await page.getByRole("form", { name: "Change the model" }).waitFor();
    await menu.getByRole("button", { name: "Pause" }).waitFor({ state: "hidden" });

    await more.click();
    await menu.getByRole("button", { name: "Pause" }).click();
    await header.getByRole("button", { name: "Resume" }).waitFor();
    await menu.getByRole("button", { name: "Copy included files" }).waitFor({ state: "hidden" });
    await more.click();
    await menu.getByRole("button", { name: "Copy included files" }).waitFor();
    expect(await menu.getByRole("button", { name: "Pause" }).count()).toBe(0);
  }, 90_000);
});
