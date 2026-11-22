import { describe, expect, test } from "bun:test";
import { ONE_REPO } from "../test/support/session-api.ts";
import { useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall(ONE_REPO);

describe("the head of the repo list", () => {
  test("it shows Add and More, the view opens on All repos with Sync all above its table; More leads to the batch command and the shell, and the folded tag filter keeps a chosen tag in sight", async () => {
    const page = await trackwall().open();
    await page
      .getByRole("navigation", { name: "Views" })
      .getByRole("button", { name: /^Repos/ })
      .click();
    const list = page.getByRole("complementary").filter({ has: page.getByRole("navigation", { name: "Repo list" }) });
    await list.getByRole("button", { name: /^Tag filter/ }).waitFor();
    // All repos (ADR-291): the first entry of the list, open, with "Sync all" above the state of every repo.
    await list.locator('button[aria-current="true"]', { hasText: "All repos" }).waitFor();
    await page.getByRole("heading", { name: "The state of every repo" }).waitFor();
    await page.getByRole("main").getByRole("button", { name: "Sync all" }).waitFor();

    // What stands above the rows of the list.
    const names = await list
      .getByRole("button")
      .filter({ visible: true })
      .evaluateAll((buttons) =>
        buttons.filter((b) => b.closest("nav") === null).map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim()),
      );
    expect(names).toEqual(["Add a repo from GitLab or GitHub", "More actions on the projects folder", "Tag filter 1"]);

    const more = list.getByRole("button", { name: "More actions on the projects folder" });
    const menu = page.getByRole("group", { name: "More actions on the projects folder" });
    await more.click();
    const items = await menu.getByRole("button").filter({ visible: true }).allInnerTexts();
    expect(items.map((name) => name.trim())).toEqual(["", "Shell", "Batch command", "Change the projects folder", "Refresh the repo list"]);
    await page.keyboard.press("Escape");
    await menu.getByRole("button", { name: "Shell" }).waitFor({ state: "hidden" });

    await more.click();
    await menu.getByRole("button", { name: "Batch command" }).click();
    await page.getByRole("heading", { name: "The same steps on many repos at once" }).waitFor();
    await menu.getByRole("button", { name: "Shell" }).waitFor({ state: "hidden" });

    // Folded, the filter shows no tag; a tag chosen while it is open stays when it folds again, and unchecks there.
    const tags = page.getByRole("group", { name: "Filter by tags" });
    const noMise = tags.getByRole("button", { name: /^#no-mise/ });
    expect(await noMise.count()).toBe(0);
    await tags.getByRole("button", { name: /^Tag filter/ }).click();
    await noMise.click();
    await tags.getByRole("button", { name: /^Tag filter/ }).click();
    expect(await noMise.getAttribute("aria-pressed")).toBe("true");
    await noMise.click();
    await noMise.waitFor({ state: "hidden" });
  }, 60_000);
});
