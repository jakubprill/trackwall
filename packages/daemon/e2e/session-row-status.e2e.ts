import { describe, expect, test } from "bun:test";
import { changeSessionLists, sessionRow, showSessions, typeInTerminal, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

/** What a conversation that called a model used, as the daemon reports it; the fake Copilot CLI reports none. */
const USAGE = { modelCalls: 3, inputTokens: 18_000, outputTokens: 400, aiCredits: 0.34, aiCreditsPartial: false, premiumRequests: 0 };

/** Makes every waiting session of a session list wait for five minutes, and every session use `USAGE`. */
function withWaitAndUsage(list: { sessions: { waitingSince: string | null; usage: unknown }[] }): void {
  const waitingSince = new Date(Date.now() - 5 * 60_000).toISOString();
  for (const session of list.sessions) {
    if (session.waitingSince !== null) session.waitingSince = waitingSince;
    session.usage = USAGE;
  }
}

describe("a session's row in the Sessions list", () => {
  test("shows how long the session has waited and what it used side by side, without one over the other", async () => {
    const page = await trackwall().open();
    // The session has waited for five minutes and used AI credits: the list reads both from the daemon, live from the
    // event socket and from its answer to the session list.
    await changeSessionLists(page, withWaitAndUsage);
    await showSessions(page);
    await page.getByRole("button", { name: "Own worktree", pressed: true }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    await typeInTerminal(page, "run the tests\r");
    await waitForTerminal(page, "Do you want to run this command?");

    const row = sessionRow(page, "shop");
    const waited = row.getByTitle(/^Waiting for you since/);
    const used = row.getByText("0.34 AI credits");
    await waited.waitFor();
    await used.waitFor();
    const a = await waited.boundingBox();
    const b = await used.boundingBox();
    if (a === null || b === null) throw new Error("the waiting time or the usage is not on the screen");
    const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect({ overlaps, waited: (await waited.textContent())?.endsWith("5 min") }).toEqual({ overlaps: false, waited: true });
  }, 60_000);
});
