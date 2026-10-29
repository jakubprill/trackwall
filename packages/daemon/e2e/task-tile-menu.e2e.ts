import { describe, test } from "bun:test";
import { join } from "node:path";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const PROMPT = "Add a seed task";

const FAKE_MISE = [process.execPath, join(import.meta.dir, "..", "test", "fixtures", "fake-mise.ts")];

const trackwall = useTrackwall({ repos: { shop: { "README.md": "# shop\n" } }, miseCommand: FAKE_MISE });

describe("a task tile's menu", () => {
  test("Changes in a task tile's menu opens the task alone on its changes", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill(PROMPT);
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, `--interactive=${PROMPT}`);
    await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "2", exact: true }).click();
    await waitForTerminal(page, `--interactive=${PROMPT}`);

    await page.getByRole("button", { name: "Task menu" }).click();
    const menu = page.getByRole("region", { name: "Task menu" });
    await menu.getByText(/^trackwall\//).waitFor();
    await menu.getByRole("button", { name: "Changes" }).click();

    await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "1", exact: true, pressed: true }).waitFor();
    await page.getByRole("tab", { name: "Changes", selected: true }).waitFor();
  }, 60_000);
});
