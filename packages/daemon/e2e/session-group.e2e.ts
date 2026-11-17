import { describe, expect, test } from "bun:test";
import { agentsApi } from "@trackwall/protocol";
import { waitFor } from "../test/support/agents.ts";
import { sessionList, sessionRow, showSessions, useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("a group of related sessions in the Sessions list", () => {
  test("keeps the group's stripe in sight beside the selected main session, apart from the selection's edge", async () => {
    const { daemon } = trackwall();
    const main = await daemon.post(agentsApi.start, { repo: "shop" });
    await waitFor(daemon.facade.agents, main.id, (s) => s.state !== null, "the main session's first state");
    // A proposal from the main session sits under it, so the two rows make a group with a stripe in its colour.
    const agent = await trackwall().agentOf(main.id);
    await agent.callTool({ name: "propose_task", arguments: { repo: "shop", title: "Add a licence", prompt: "Add an MIT LICENSE file" } });

    const page = await trackwall().open();
    await showSessions(page);
    await sessionList(page)
      .getByRole("button", { name: /Task proposal/ })
      .waitFor();
    const row = sessionRow(page, "shop").first();
    await row.click();
    await expect(row.getAttribute("aria-current")).resolves.toBe("true");

    // The selected row paints its background and its edge at its left side: a stripe there would lie under them.
    const seen = await row.evaluate((button) => {
      const stripe = button.closest(".group\\/row")?.querySelector("[data-group-stripe]");
      if (!stripe) throw new Error("the selected main session has no group stripe");
      const s = stripe.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      return { besideTheRow: s.right <= b.left, visible: s.width > 0 && s.height > 0 };
    });
    expect(seen).toEqual({ besideTheRow: true, visible: true });
  }, 60_000);
});
