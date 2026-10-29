import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const PROMPT = "Add a seed task";

const FAKE_MISE = [process.execPath, join(import.meta.dir, "..", "test", "fixtures", "fake-mise.ts")];

const trackwall = useTrackwall({ repos: { shop: { "README.md": "# shop\n" } }, miseCommand: FAKE_MISE });

describe("a task's notices", () => {
  test("a warning that comes while the grid shows the task lies over its terminal, and the mise chip in the tile's header opens the config to trust without resizing the terminal", async () => {
    const { daemon } = trackwall();
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill(PROMPT);
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, `--interactive=${PROMPT}`);
    await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "2", exact: true }).click();
    await waitForTerminal(page, `--interactive=${PROMPT}`);
    const terminal = page.locator(".xterm");
    const before = await terminal.boundingBox();

    // The agent's work: a mise config in its worktree, which Trackwall does not run until the user trusts it.
    const task = daemon.facade.agents.sessions().tasks.find((t) => t.prompt === PROMPT);
    if (task === undefined) throw new Error("the task is not on the list");
    writeFileSync(join(task.worktree, "mise.local.toml"), '[tasks.seed]\nrun = "echo seed"\n');
    const banner = page.getByRole("status").filter({ hasText: "The agent changed the mise config" });
    await banner.waitFor();
    await banner.getByRole("button", { name: "Show" }).click();

    const overlay = page.getByRole("region", { name: "mise config overlay" });
    await overlay.getByRole("region", { name: "mise config of this worktree" }).getByText("added mise.local.toml").waitFor();
    expect(await terminal.boundingBox()).toEqual(before);
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "hidden" });
    expect(await banner.count()).toBe(0);
    // The chip stays in the tile's header until the config is trusted.
    const chip = page.getByRole("button", { name: "The agent changed the mise config" });
    await chip.waitFor();

    // In the one-entry layout the same warning is a chip that opens the task's sections.
    await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "1", exact: true }).click();
    await page.getByRole("list", { name: "Task notices" }).getByRole("button", { name: "The agent changed the mise config" }).waitFor();

    await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "2", exact: true }).click();
    await chip.click();
    await overlay.getByRole("button", { name: "Trust this config" }).click();
    await chip.waitFor({ state: "detached" });
  }, 60_000);
});
