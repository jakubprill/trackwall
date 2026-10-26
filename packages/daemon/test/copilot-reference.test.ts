import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { COPILOT_CLI_VERSION } from "../scripts/copilot-cli.ts";
import { readAgentDialog } from "../src/modules/agents/copilot-dialog.ts";
import { promptBoxOnScreen } from "../src/modules/agents/copilot-prompt-box.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";
import { anonymize, PROMPT_PLACEHOLDER, type ReferenceHook, readReference, referenceFile } from "./support/copilot-reference.ts";

const platforms = readdirSync(dirname(referenceFile()))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""));

/** The states the daemon gives the reference's hooks of a session without a prompt at its start. */
function states(hooks: readonly ReferenceHook[]): string[] {
  const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });
  return hooks
    .flatMap(({ event, payload }) => session.hook({ event, receivedAt: 0, payload, omitted: [] }, () => false))
    .map((c) => c.state);
}

describe("the Copilot CLI references that the fake replays (ADR-67)", () => {
  test("there is one for Linux, macOS and Windows", () => {
    expect(platforms.sort()).toEqual(["darwin", "linux", "win32"]);
  });

  for (const platform of platforms) {
    test(`${platform}: taken from the pinned Copilot CLI and read by the daemon as the real screen and hooks`, () => {
      const reference = readReference(platform);
      if (reference === undefined) throw new Error(`no reference for ${platform}`);

      expect(reference).toMatchObject({ copilotVersion: COPILOT_CLI_VERSION, platform });
      expect(promptBoxOnScreen(reference.promptBox)).toBe("empty");
      const dialog = readAgentDialog(reference.approval.dialog, "approval");
      if (dialog?.kind !== "approval") throw new Error(`no approval dialog in the reference for ${platform}`);
      // "Yes" may be the only option (a PowerShell command on Windows); it is the one the fake is answered with.
      expect(dialog.options[0]).toEqual({ key: "1", label: "Yes" });
      expect(states(reference.turn)).toEqual(["Input", "Working", "Input"]);
      expect(states(reference.approval.hooks)).toEqual(["Input", "Working", "Approval", "Working", "Input"]);
      expect(states(reference.exit)).toEqual(["Done"]);
    });
  }
});

describe("paths in a reference", () => {
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

  test("shortened by Copilot CLI to fit the screen are replaced by the projects folder and the last part", () => {
    expect(anonymize("in this repo (/private/var/folders/x1/.../shop)", [])).toBe("in this repo (/projects/shop)");
    expect(anonymize(String.raw`in this repo (C:\Users\RUNNER~1\...\shop)`, [])).toBe("in this repo (/projects/shop)");
    expect(anonymize("│ repo (/tmp/.../shop)    │", [])).toBe("│ repo (/projects/shop)   │");
  });
});

describe("the window title of a Copilot CLI session on Windows", () => {
  const program = String.raw`C:\Users\dev\AppData\Roaming\npm\node_modules\@github\copilot-win32-x64\copilot.exe`;
  const osc = (title: string) => `\u001b]0;${title}\u0007`;

  test("is not the program path that ConPTY sets before Copilot CLI sets its own", () => {
    const [startTitle, turnTitle] = readReference("win32")?.titles ?? [];
    if (startTitle === undefined || turnTitle === undefined) throw new Error("no window titles in the Windows reference");
    const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program });

    session.output(osc(program));
    expect(session.windowTitle).toBeUndefined();

    session.output(osc(startTitle));
    expect(session.windowTitle).toBe("GitHub Copilot");

    session.output(osc(turnTitle.replaceAll(PROMPT_PLACEHOLDER, "fix the test")));
    expect(session.windowTitle).toBe("fix the test - GitHub Copilot");
  });

  test("set by Copilot CLI to any other path stays the session's title", () => {
    const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program });

    session.output(osc(String.raw`C:\Projects\shop`));

    expect(session.windowTitle).toBe(String.raw`C:\Projects\shop`);
  });
});
