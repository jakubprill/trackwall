import { describe, expect, test } from "bun:test";
import { showHome, showSessions, typeInTerminal, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

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

    await page
      .getByRole("navigation", { name: "Views" })
      .getByRole("button", { name: /^Settings/ })
      .click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^App/ }).click();
    const row = page.getByRole("button", { name: /^Tips and What's new/ });
    await row.getByText("off", { exact: true }).waitFor();
    await row.click();
    await page.getByRole("radio", { name: /^On/ }).check();
    await showSessions(page);
    await tip.waitFor();
    await page.getByRole("region", { name: "What's new" }).waitFor();
  });

  test("Plan first, Verify and Always allow show their tips where a new user meets them, each when the one before is answered", async () => {
    const page = await trackwall().open(undefined, { tips: true });
    const tip = (label: string) => page.getByRole("region", { name: `Tip: ${label}` });
    // Out of the way, so that the task's terminal keeps the rows its approval dialog needs.
    await page.getByRole("region", { name: "What's new" }).getByRole("button", { name: "Dismiss" }).click();
    await tip("Own worktree").getByRole("button", { name: "Got it" }).click();

    await page.getByRole("button", { name: /^More options/ }).click();
    await tip("Plan first").getByText("Read the agent's plan before it changes a file").waitFor();
    await tip("Plan first").getByRole("button", { name: "Got it" }).click();

    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill("Add a discount to the cart");
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, "--interactive=Add a discount to the cart");
    await typeInTerminal(page, "go on\r");
    await waitForTerminal(page, "Do you want to run this command?");
    // The task waits for its approval, so Next waiting is on screen, and its tip comes before the one of Verify.
    await tip("Next waiting").getByRole("button", { name: "Got it" }).click();
    await tip("Verify").getByText("Run the task's tests where its agent works").waitFor();
    await tip("Verify").getByRole("button", { name: "Got it" }).click();

    await showHome(page);
    await page.getByRole("list", { name: "Sessions that need you" }).getByRole("button").filter({ hasText: "approval" }).click();
    const answers = page.getByRole("group", { name: "Answers" });
    await answers.getByRole("button", { name: "Stop the agent" }).waitFor();
    if (process.platform === "win32") {
      // A PowerShell command has no "don't ask again" in Copilot CLI, so a task on Windows offers no Always allow (ADR-249).
      expect(await answers.getByRole("button", { name: /^Always allow/ }).count()).toBe(0);
      expect(await tip("Always allow").count()).toBe(0);
      return;
    }
    await answers.getByRole("button", { name: /^Always allow/ }).waitFor();
    await tip("Always allow").getByText("Every task of this repo runs it without asking").waitFor();
    await tip("Always allow").getByRole("button", { name: "Got it" }).click();
    await tip("Always allow").waitFor({ state: "detached" });
  }, 60_000);
});
