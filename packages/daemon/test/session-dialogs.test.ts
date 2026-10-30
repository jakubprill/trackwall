import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionDialogs } from "../src/modules/agents/session-dialogs.ts";

/** A screen of Copilot CLI 1.0.103 with a command approval, as `agent-dialog.test.ts` reads it. */
const APPROVAL = readFileSync(join(import.meta.dir, "fixtures", "copilot", "dialog-shell-120.txt"), "utf8").split("\n");

describe("the dialog a session's screen shows", () => {
  test("keeps its id while the screen and the wait hold, and gets a new one for the next wait on the same screen", () => {
    const screen = { revision: 1, lines: () => APPROVAL };
    const dialogs = new SessionDialogs(screen);
    dialogs.waitStarted(false);

    const first = dialogs.onScreen("approval");
    expect(dialogs.onScreen("approval")?.id).toBe(first?.id);
    screen.revision = 2;
    expect(dialogs.onScreen("approval")?.id).toBe(first?.id);

    dialogs.waitStarted(false);

    expect(dialogs.onScreen("approval")?.id).not.toBe(first?.id);
  });
});
