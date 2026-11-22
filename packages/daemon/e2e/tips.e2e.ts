import { describe, expect, test } from "bun:test";
import { showSessions, useTrackwall } from "./support/trackwall-ui.ts";

/**
 * Tips and What's new (ADR-296) on a computer that used Trackwall before an update: its daemon has a projects folder,
 * so the window lists What's new, and with no session yet, Sessions opens on the New session form, whose Own worktree
 * pill has the first tip a new user meets.
 */
describe("tips and What's new", () => {
  const trackwall = useTrackwall();

  test("after an update, Show of What's new brings back a seen tip where it lives, and what the user answered stays after a reload", async () => {
    const page = await trackwall().open(undefined, { tips: true });
    const whatsNew = page.getByRole("region", { name: "What's new" });
    const tip = page.getByRole("region", { name: "Tip: Own worktree" });
    await tip.getByText("On, the prompt becomes a task on a branch of its own").waitFor();
    await tip.getByRole("button", { name: "Got it" }).click();
    await tip.waitFor({ state: "detached" });

    await whatsNew.getByRole("button", { name: "Show Tips" }).click();
    await tip.getByRole("button", { name: "Got it" }).click();
    await tip.waitFor({ state: "detached" });
    await page.reload();
    await page.getByRole("button", { name: "Own worktree", pressed: true }).waitFor();
    await whatsNew.waitFor();
    expect(await tip.count()).toBe(0);

    await whatsNew.getByRole("button", { name: "Dismiss" }).click();
    await whatsNew.waitFor({ state: "detached" });
    await page.reload();
    await page.getByRole("button", { name: "Own worktree", pressed: true }).waitFor();
    expect(await whatsNew.count()).toBe(0);
  });

  test("Turn off tips hides the tip and What's new at once, and Settings turns them on again", async () => {
    const page = await trackwall().open(undefined, { tips: true });
    const tip = page.getByRole("region", { name: "Tip: Own worktree" });
    await page.getByRole("region", { name: "What's new" }).waitFor();
    await tip.getByRole("button", { name: "Turn off tips" }).click();
    await tip.waitFor({ state: "detached" });
    await page.getByRole("region", { name: "What's new" }).waitFor({ state: "detached" });

    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Settings/ }).click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^App/ }).click();
    const row = page.getByRole("button", { name: /^Tips and What's new/ });
    await row.getByText("off", { exact: true }).waitFor();
    await row.click();
    await page.getByRole("radio", { name: /^On/ }).check();
    await showSessions(page);
    await tip.waitFor();
    await page.getByRole("region", { name: "What's new" }).waitFor();
  });
});
