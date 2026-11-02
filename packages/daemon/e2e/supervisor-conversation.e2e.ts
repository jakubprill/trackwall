import { describe, test } from "bun:test";
import { useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("the supervisor in the conversation view (ADR-107)", () => {
  test("a supervisor started in the conversation view switches to Plan, suggests slash commands, takes a message with a file attached, asks for its approval in the panel, shows its answer, its folded thought and its context use, drops the message box once stopped, and offers to continue it", async () => {
    const page = await trackwall().open();
    await page.getByRole("button", { name: /Pin the supervisor panel open/ }).click();
    const panel = page.getByRole("complementary", { name: "Supervisor" });
    await panel.getByRole("button", { name: "Chat (preview)" }).click();
    await panel.getByRole("button", { name: "New conversation" }).click();

    const modes = panel.getByRole("group", { name: "Mode" });
    await modes.getByRole("button", { name: "Agent", pressed: true }).waitFor();
    await modes.getByRole("button", { name: "Plan" }).click();
    await modes.getByRole("button", { name: "Plan", pressed: true }).waitFor();

    const message = panel.getByRole("textbox", { name: "Message to the agent" });
    await message.fill("/c");
    const commands = panel.getByRole("listbox", { name: "Slash commands" });
    await commands.getByRole("option", { name: /\/compact/ }).waitFor();
    await message.press("Tab");
    await commands.waitFor({ state: "detached" });
    if ((await message.inputValue()) !== "/compact ") throw new Error(`the command was not picked: ${await message.inputValue()}`);

    await panel
      .getByLabel("Files to attach")
      .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("the build is red\n") });
    await panel.getByRole("list", { name: "Attachments" }).getByText("notes.txt").waitFor();
    await message.fill("check the build");
    await message.press("Enter");
    await panel.getByText("Do you want to allow this?").waitFor();
    await panel.getByRole("button", { name: "Allow once" }).click();

    const conversation = panel.getByRole("log", { name: "Conversation" });
    await conversation.getByText("check the build", { exact: true }).waitFor();
    await conversation.getByText(/Thinking about: check the build/).waitFor();
    await conversation.getByRole("list", { name: "Attached" }).getByText("notes.txt").waitFor();
    await conversation.getByText(/Text: <attached-file name="notes\.txt">/).waitFor();
    await conversation.getByText("Make a file").waitFor();
    // The model's reasoning is folded under "Thought" and opens on a click. As the turn ends the followed list scrolls
    // (the dots of a working agent go, the context meter joins the line above the message box), which can move the row
    // between the moment the click aims and the moment it lands, so the click is tried again until the row opens.
    await panel.getByText("Your turn: the agent waits for your message").waitFor();
    const reasoning = conversation.getByText("Reasoning about: check the build");
    for (let tries = 0; !(await reasoning.isVisible()) && tries < 5; tries++) {
      await conversation.getByText("Thought", { exact: true }).click();
      await reasoning.waitFor({ timeout: 1000 }).catch(() => {});
    }
    await reasoning.waitFor();
    await panel.getByText("Context used:").waitFor({ state: "attached" });

    await panel.getByRole("button", { name: "Stop", exact: true }).click();
    await panel.getByText("The session has ended; this is its conversation.").waitFor();
    await message.waitFor({ state: "detached" });
    // Without a day start today, the start card puts Start my day first and offers to continue the stopped conversation (ADR-126).
    await panel.getByText(/^stopped at /).waitFor();
    await panel.getByRole("button", { name: "Start my day" }).waitFor();
    await panel.getByRole("button", { name: "Continue", exact: true }).waitFor();
  }, 60_000);
});
