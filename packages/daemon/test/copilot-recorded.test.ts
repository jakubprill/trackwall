import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { COPILOT_CLI_VERSION } from "../scripts/copilot-cli.ts";
import { readAgentDialog } from "../src/modules/agents/copilot-dialog.ts";
import { promptBoxOnScreen } from "../src/modules/agents/copilot-prompt-box.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";
import { anonymize, type RecordedHook, readRecorded, recordedFile } from "./support/copilot-recorded.ts";

const platforms = readdirSync(dirname(recordedFile())).map((name) => name.replace(/\.json$/, ""));

/** The states the daemon gives the recorded hooks of a session without a prompt at its start. */
function states(hooks: readonly RecordedHook[]): string[] {
  const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false });
  return hooks.flatMap(({ event, payload }) => session.hook({ event, receivedAt: 0, payload, omitted: [] })).map((c) => c.state);
}

describe("the recordings of the real Copilot CLI that the fake replays (ADR-69)", () => {
  test("there is one for Linux, macOS and Windows", () => {
    expect(platforms.sort()).toEqual(["darwin", "linux", "win32"]);
  });

  for (const platform of platforms) {
    test(`${platform}: taken from the pinned Copilot CLI and read by the daemon as the real screen and hooks`, () => {
      const recorded = readRecorded(platform);
      if (recorded === undefined) throw new Error(`no recording for ${platform}`);

      expect(recorded).toMatchObject({ copilotVersion: COPILOT_CLI_VERSION, platform });
      expect(promptBoxOnScreen(recorded.promptBox)).toBe("empty");
      const dialog = readAgentDialog(recorded.approval.dialog, "approval");
      if (dialog?.kind !== "approval") throw new Error(`no approval dialog in the recording for ${platform}`);
      // "Yes" may be the only option (a PowerShell command on Windows); it is the one the fake is answered with.
      expect(dialog.options[0]).toEqual({ key: "1", label: "Yes" });
      expect(states(recorded.turn)).toEqual(["Input", "Working", "Input"]);
      expect(states(recorded.approval.hooks)).toEqual(["Input", "Working", "Approval", "Working", "Input"]);
      expect(states(recorded.exit)).toEqual(["Done"]);
    });
  }
});

describe("paths in a recording", () => {
  test("are replaced, and a box line keeps its right border where the screen had it", () => {
    const line = "│   2. Yes, and don't ask again in this repo (/tmp/trackwall-projects-x1/shop)   │";

    expect(anonymize(line, ["/tmp/trackwall-projects-x1"])).toBe(
      "│   2. Yes, and don't ask again in this repo (/projects/shop)                    │",
    );
    expect(anonymize(line, ["/tmp/trackwall-projects-x1"])).toHaveLength(line.length);
    expect(anonymize("Run command: touch /tmp/trackwall-projects-x1/shop/a.txt", ["/tmp/trackwall-projects-x1"])).toBe(
      "Run command: touch /projects/shop/a.txt",
    );
  });
});
