import { describe, expect, test } from "bun:test";
import { WIDER_FONT } from "./support/layout-faults.ts";
import { overlapsIn } from "./support/overlap.ts";
import {
  changeSessionLists,
  type SessionListBody,
  SMALL_SCREEN,
  sessionRow,
  showSessions,
  useTrackwall,
  waitForTerminal,
} from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

/** What a long conversation used, as the daemon reports it; the fake Copilot CLI reports none. */
const USAGE = {
  modelCalls: 90,
  inputTokens: 9_000_000,
  outputTokens: 40_000,
  aiCredits: 3437,
  aiCreditsPartial: false,
  premiumRequests: 0,
};

/** Makes every session of a session list probably working (a guess from a weak signal) and use `USAGE`. */
function probablyWorkingWithUsage(list: SessionListBody): void {
  for (const session of list.sessions) {
    session.usage = USAGE;
    if (session.state !== null) {
      session.state.state = "Working";
      session.state.confidence = "low";
    }
  }
}

describe("a task's state and usage", () => {
  test("are drawn apart from each other and from the buttons, in its row and in its header, with a wider font on a small screen", async () => {
    const page = await trackwall().open(SMALL_SCREEN);
    await changeSessionLists(page, probablyWorkingWithUsage);
    await page.addStyleTag({ content: WIDER_FONT });
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill("Add a discount to the cart");
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, "--interactive=Add a discount");
    const row = sessionRow(page, "shop");
    await row
      .getByTitle(/^A guess/)
      .getByText("Working")
      .waitFor();
    await row.getByText("3.4k cr").waitFor();
    const header = page.locator("header").filter({ hasText: "3437 AI credits" });

    const found = [...(await row.evaluate(overlapsIn)), ...(await header.evaluate(overlapsIn))];

    expect(found).toEqual([]);
  }, 60_000);
});
