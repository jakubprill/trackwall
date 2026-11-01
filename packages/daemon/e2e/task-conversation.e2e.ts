import { describe, expect, test } from "bun:test";
import { showSessions, useTrackwall } from "./support/trackwall-ui.ts";

const PROMPT = "Fix the login";

const trackwall = useTrackwall({ repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"] });

describe("an agent task in Chat (ADR-137)", () => {
  test("a task started in Chat shows its conversation in a Chat tab of the task panel, not a terminal it does not have", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill(PROMPT);
    await page.getByRole("button", { name: /Chat \(preview\)/ }).click();
    await page.getByRole("button", { name: "Create task" }).click();
    // Layout "1", the default: the task with its full panel, where the bug was; the grid's tiles already showed Chat.
    await page.getByRole("button", { name: "1", exact: true, pressed: true }).waitFor();

    await page.getByRole("tab", { name: "Chat" }).waitFor();
    const conversation = page.getByRole("log", { name: "Conversation" });
    await conversation.getByText(PROMPT, { exact: true }).waitFor();
    // The fake asks to run its first tool, and the question is answered in the conversation.
    await page.getByText("Do you want to allow this?").waitFor();
    await page.getByRole("button", { name: "Allow once" }).click();
    await conversation.getByText(/Thinking about: Fix the login/).waitFor();
    await page.getByRole("textbox", { name: "Message to the agent" }).waitFor();
    expect(await page.getByRole("tab", { name: "Terminal" }).count()).toBe(0);
    expect(await page.getByText("Lost the connection to the session terminal; reconnecting…").count()).toBe(0);
  }, 60_000);
});
