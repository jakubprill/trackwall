import { describe, test } from "bun:test";
import { useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("the supervisor in the conversation view (ADR-107)", () => {
  test("a supervisor started in the conversation view takes a message, asks for its approval in the panel, shows its answer, and drops the message box once stopped", async () => {
    const page = await trackwall().open();
    await page.getByRole("button", { name: /Pin the supervisor panel open/ }).click();
    const panel = page.getByRole("complementary", { name: "Supervisor" });
    await panel.getByRole("button", { name: "Start in the conversation view" }).click();
    await panel.getByRole("button", { name: "Start supervisor" }).click();

    const message = panel.getByRole("textbox", { name: "Message to the agent" });
    await message.fill("check the build");
    await message.press("Enter");
    await panel.getByText("Do you want to allow this?").waitFor();
    await panel.getByRole("button", { name: "Allow once" }).click();

    const conversation = panel.getByRole("log", { name: "Conversation" });
    await conversation.getByText("check the build", { exact: true }).waitFor();
    await conversation.getByText(/Thinking about: check the build/).waitFor();
    await conversation.getByText("Make a file").waitFor();

    await panel.getByRole("button", { name: "Stop", exact: true }).click();
    await panel.getByText("The session has ended; this is its conversation.").waitFor();
    await message.waitFor({ state: "detached" });
  }, 60_000);
});
