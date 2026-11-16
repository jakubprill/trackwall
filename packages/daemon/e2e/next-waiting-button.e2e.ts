import { describe, expect, test } from "bun:test";
import { changeSessionLists, showSessions, useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

/** Makes the supervisor of a session list wait for the user, as when its Copilot CLI asks for an approval. */
function withSupervisorWaiting(list: { sessions: { supervisor: boolean; needsAttention: boolean }[] }): void {
  for (const session of list.sessions) if (session.supervisor) session.needsAttention = true;
}

describe("the Next waiting button of the Sessions list", () => {
  test("keeps its longest label and its shortcut inside its frame when the system font is wider", async () => {
    const page = await trackwall().open();
    await changeSessionLists(page, withSupervisorWaiting);
    // The UI takes the system's font (Segoe UI on Windows), whose words run wider than the fallback font of the test
    // browser; wider letter spacing stands in for it.
    await page.addStyleTag({ content: "body { letter-spacing: 0.06em; }" });
    await page.getByRole("button", { name: /Pin the supervisor panel open/ }).click();
    await page.getByRole("complementary", { name: "Supervisor" }).getByRole("button", { name: "New conversation" }).click();
    await showSessions(page);

    const button = page.getByRole("button", { name: /The supervisor is waiting for you/ });
    await button.waitFor();
    const frame = await button.boundingBox();
    const shortcut = await button.getByText("Alt+J").boundingBox();
    if (frame === null || shortcut === null) throw new Error("the button or its shortcut is not on the screen");
    const overflows = await button.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect({ overflows, shortcutInside: shortcut.x + shortcut.width <= frame.x + frame.width }).toEqual({
      overflows: false,
      shortcutInside: true,
    });
  }, 60_000);
});
