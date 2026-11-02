import { describe, test } from "bun:test";
import { useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("the supervisor in the conversation view (ADR-107)", () => {
  test("a supervisor started in the conversation view switches to Plan, suggests slash commands, takes a message, asks for its approval in the panel, shows its answer, its folded thought and its context use, drops the message box once stopped, and offers to continue it", async () => {
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

    await message.fill("check the build");
    await message.press("Enter");
    await panel.getByText("Do you want to allow this?").waitFor();
    await panel.getByRole("button", { name: "Allow once" }).click();

    const conversation = panel.getByRole("log", { name: "Conversation" });
    await conversation.getByText("check the build", { exact: true }).waitFor();
    await conversation.getByText(/Thinking about: check the build/).waitFor();
    await conversation.getByText("Make a file").waitFor();
    // The model's reasoning is folded under "Thought" and opens on a click, once the turn has ended and the panel
    // stopped moving (the line above the message box changes as it ends).
    await panel.getByText("Your turn: the agent waits for your message").waitFor();
    await conversation.getByText("Thought", { exact: true }).click();
    await conversation.getByText("Reasoning about: check the build").waitFor();
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
