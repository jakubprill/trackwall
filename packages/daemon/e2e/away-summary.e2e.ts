import { describe, expect, test } from "bun:test";
import { agentsApi } from "@trackwall/protocol";
import { waitFor } from "../test/support/agents.ts";
import { useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("while you were away (ADR-151)", () => {
  test("after two hours without the user their first move shows what changed, an item opens its proposal, and Dismiss clears the strip", async () => {
    const { daemon } = trackwall();
    const main = await daemon.post(agentsApi.start, { repo: "shop" });
    await waitFor(daemon.facade.agents, main.id, (s) => s.state !== null, "the main session's first state");
    const agent = await trackwall().agentOf(main.id);
    await agent.callTool({ name: "propose_task", arguments: { repo: "shop", title: "Add a licence", prompt: "Add an MIT LICENSE file" } });

    const page = await trackwall().open();
    // The last sign of the user two hours ago, as every window writes it (`away-presence.ts`), read as the page loads.
    await page.evaluate((at) => localStorage.setItem("trackwall.presence.last-active", String(at)), Date.now() - 2 * 3_600_000);
    await page.reload();
    await page.getByRole("navigation", { name: "Views" }).waitFor();
    await page.mouse.move(400, 300);

    const strip = page.getByRole("region", { name: "While you were away" });
    await strip.getByText(/^While you were away \(2 h 0 min\): 2 changes, 2 need you$/).waitFor();
    await strip.getByRole("button", { name: "Show", exact: true }).click();
    await strip.getByRole("button").filter({ hasText: "waiting for you" }).filter({ hasNotText: "Add a licence" }).waitFor();
    await strip.getByRole("button").filter({ hasText: "shop · Add a licence" }).filter({ hasText: "waiting for your decision" }).click();
    await page.getByRole("textbox", { name: "Prompt for the agent: Add a licence" }).waitFor();

    await strip.getByRole("button", { name: "Dismiss" }).click();
    await strip.waitFor({ state: "detached" });
    expect(await page.evaluate(() => localStorage.getItem("trackwall.presence.away"))).toBeNull();
  }, 60_000);
});
