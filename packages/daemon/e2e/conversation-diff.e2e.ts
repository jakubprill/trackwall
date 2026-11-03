import { describe, expect, test } from "bun:test";
import { FAKE_ACP_EDIT_LINE } from "../test/fixtures/fake-copilot-acp.ts";
import { showSessions, useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall({ repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"] });

describe("the diff panel of the conversation view (ADR-107)", () => {
  test("a file the agent changed opens in the diff panel beside the conversation, which ✕ closes while the conversation goes on", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill("Edit the README");
    await page.getByRole("button", { name: /Chat \(preview\)/ }).click();
    await page.getByRole("button", { name: "Create task" }).click();
    await page.getByRole("button", { name: "Allow once" }).click();
    const conversation = page.getByRole("log", { name: "Conversation" });
    await conversation.getByText(/Thinking about: Edit the README/).waitFor();

    // Closed at first: nothing beside the conversation until the user picks a change.
    const panel = page.getByRole("complementary", { name: "Changes of the turn" });
    expect(await panel.count()).toBe(0);
    await conversation.getByRole("button", { name: "Show diff" }).click();
    await panel.getByText("README.md", { exact: true }).waitFor();
    await panel.getByText(`+${FAKE_ACP_EDIT_LINE}`).waitFor();

    await panel.getByRole("button", { name: "Close the diff" }).click();
    await panel.waitFor({ state: "detached" });
    const message = page.getByRole("textbox", { name: "Message to the agent" });
    await message.fill("thanks");
    await message.press("Enter");
    await page.getByRole("button", { name: "Allow once" }).click();
    await conversation.getByText(/Thinking about: thanks/).waitFor();
  }, 60_000);
});
