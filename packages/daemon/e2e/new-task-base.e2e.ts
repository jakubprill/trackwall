import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFiles, gitIn } from "../test/support/git-repo.ts";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("where a new task starts (ADR-296)", () => {
  test("with main behind origin/main under a feature branch, the New task form says so, Sync main moves main alone, and the task starts from the server's main", async () => {
    const { daemon } = trackwall();
    const shop = join(daemon.projects, "shop");
    // The server: a clone of shop, which got a colleague's commit that the user's editor has fetched since.
    const server = join(mkdtempSync(join(tmpdir(), "trackwall-remotes-")), "shop");
    gitIn(daemon.projects, "clone", "-q", shop, server);
    commitFiles(server, { "orders.txt": "1" }, "Add orders");
    gitIn(shop, "remote", "add", "origin", server);
    gitIn(shop, "fetch", "-q", "origin");
    gitIn(shop, "remote", "set-head", "origin", "main");
    gitIn(shop, "checkout", "-q", "-b", "size-filter");

    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("button", { name: "New task or Copilot CLI session" }).click();
    const behind = page.getByRole("status").filter({ hasText: "main is 1 commit behind origin/main" });
    await behind.getByText("The task starts from main, so its agent would work on older code.").waitFor();
    await behind.getByRole("button", { name: "Sync main" }).click();

    await page
      .getByRole("status")
      .filter({
        hasText:
          "main moved 1 commit forward to origin/main. The working directory is on size-filter, so files in the working directory did not change.",
      })
      .waitFor();
    expect(gitIn(shop, "rev-parse", "main").trim()).toBe(gitIn(server, "rev-parse", "HEAD").trim());
    expect(gitIn(shop, "branch", "--show-current").trim()).toBe("size-filter");

    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill("Add order totals");
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, "--interactive=Add order totals");
    const [task] = daemon.facade.agents.sessions().tasks;
    expect(task?.base).toBe(gitIn(server, "rev-parse", "HEAD").trim());
  }, 60_000);
});
