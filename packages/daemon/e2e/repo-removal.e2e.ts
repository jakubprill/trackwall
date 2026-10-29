import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentsApi, TRACKWALL_DIR } from "@trackwall/protocol";
import { waitFor } from "../test/support/agents.ts";
import { sessionList, showSessions, useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall({
  repos: { shop: { "README.md": "# shop\n" }, docs: { "README.md": "# docs\n" } },
  miseCommand: ["mise"],
});

describe("a repo removal proposed by a session (ADR-83)", () => {
  test("the user reads the reason and removes the repo, which moves out of the projects folder", async () => {
    const { daemon } = trackwall();
    const main = await daemon.post(agentsApi.start, { repo: "shop" });
    await waitFor(daemon.facade.agents, main.id, (s) => s.state !== null, "the main session's first state");
    const agent = await trackwall().agentOf(main.id);
    await agent.callTool({
      name: "propose_folder_action",
      arguments: { action: "remove_repo", repo: "docs", reason: "The docs moved to the wiki" },
    });

    const page = await trackwall().open();
    await showSessions(page);
    await sessionList(page)
      .getByRole("button", { name: /Repo removal/ })
      .click();
    await page.getByText("The docs moved to the wiki").waitFor();
    await page.getByRole("button", { name: "Remove repo" }).click();

    await sessionList(page)
      .getByRole("button", { name: /Repo removal/ })
      .waitFor({ state: "detached" });
    expect(existsSync(join(daemon.projects, TRACKWALL_DIR, "removed", "docs", "README.md"))).toBe(true);
    expect(existsSync(join(daemon.projects, "docs"))).toBe(false);
  }, 60_000);
});
