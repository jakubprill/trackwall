import { describe, expect, test } from "bun:test";
import { FAKE_ACP_EDIT_LINE } from "../test/fixtures/fake-copilot-acp.ts";
import { showSessions, useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall({ repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"] });

describe("the diff panel of the conversation view (ADR-107)", () => {
  test("a file the agent changed opens in the diff panel beside the conversation, a line of it goes into the message or the task's review, and ✕ closes the panel while the conversation goes on", async () => {
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

    // "Ask about this" puts the line in front of the message; "Comment" adds it to the task's review.
    const lineActions = panel.getByRole("button", { name: "Actions for line 2 of README.md" });
    await lineActions.click();
    await panel.getByRole("button", { name: "Ask about this" }).click();
    const message = page.getByRole("textbox", { name: "Message to the agent" });
    const quote = `About README.md, line 2:\n> ${FAKE_ACP_EDIT_LINE}\n\n`;
    // The box takes the quote in an effect after the click, so wait for it rather than read at once.
    await page.waitForFunction(
      (text) => document.activeElement instanceof HTMLTextAreaElement && document.activeElement.value === text,
      quote,
    );
    await lineActions.click();
    await panel.getByRole("button", { name: "Comment" }).click();
    await panel.getByRole("textbox", { name: "Comment on line 2 of README.md" }).fill("Say why it was edited");
    await panel.getByRole("button", { name: "Add comment" }).click();
    await panel.getByRole("region", { name: "Review for the agent" }).getByText("Say why it was edited").waitFor();

    await panel.getByRole("button", { name: "Close the diff" }).click();
    await panel.waitFor({ state: "detached" });
    await message.fill("thanks");
    await message.press("Enter");
    await page.getByRole("button", { name: "Allow once" }).click();
    await conversation.getByText(/Thinking about: thanks/).waitFor();
  }, 60_000);
});
