/**
 * The recording of the real Copilot CLI (`test/support/copilot-recorded.ts`, ADR-69) taken and checked by the contract
 * tests: each test hands over what it saw, which is compared with this system's recording, or, with
 * `TRACKWALL_RECORD=1`, written as the new recording when all tests are done. A missing recording or a difference
 * prints the whole recording seen, so one from a CI system can be taken from its log.
 */
import { expect } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COPILOT_CLI_VERSION } from "../../scripts/copilot-cli.ts";
import { readAgentDialog } from "../../src/modules/agents/copilot-dialog.ts";
import type { CopilotHookRecord } from "../../src/modules/agents/copilot-hook-record.ts";
import { windowTitleFromOsc } from "../../src/modules/agents/copilot-osc.ts";
import { OscParser } from "../../src/modules/agents/osc-parser.ts";
import { TerminalScreen } from "../../src/modules/agents/terminal-screen.ts";
import type { viewer } from "../../test/support/agents.ts";
import {
  anonymize,
  CopilotRecorded,
  PROMPT_PLACEHOLDER,
  RECORDED_COLS,
  RECORDED_ROWS,
  type RecordedHook,
  readRecorded,
  recordedFile,
} from "../../test/support/copilot-recorded.ts";

type Window = ReturnType<typeof viewer>;

/** The input box, its two rules and the footer. */
const PROMPT_BOX_LINES = 4;

/** The window's screen as Copilot CLI drew it in the recording's size, once the emulator has processed all output. */
async function screenLines(window: Window): Promise<string[]> {
  const screen = new TerminalScreen(RECORDED_COLS, RECORDED_ROWS);
  try {
    screen.write(new TextEncoder().encode(window.text()));
    await new Promise<void>((resolve) =>
      screen.attach(
        () => {},
        () => resolve(),
      ),
    );
    return screen.lines().map((l) => l.trimEnd());
  } finally {
    screen.dispose();
  }
}

export function startRecorder(daemon: { home: string; projects: string }) {
  const recording = process.env.TRACKWALL_RECORD === "1";
  const known = readRecorded();
  const seen: Partial<CopilotRecorded> = { copilotVersion: COPILOT_CLI_VERSION, platform: process.platform };
  let differs = false;
  // Copilot CLI names directories by their real path (macOS: /private/var/… for /var/…), and on Windows by the long one.
  const paths = [...new Set([daemon.projects, daemon.home].flatMap((p) => [p, realpathSync.native(p)]))];
  const clean = (text: string) => anonymize(text, paths);

  function hooks(records: readonly CopilotHookRecord[]): RecordedHook[] {
    return records.map(({ event, payload, omitted }) => {
      const { sessionId: _, timestamp: __, ...kept } = payload;
      const cleaned = Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, typeof v === "string" ? clean(v) : v]));
      return { event, payload: cleaned, omitted: [...omitted].sort() };
    });
  }

  /** Compares one part with the recording (or keeps it for writing); `compare` maps both sides first. */
  function check<K extends keyof CopilotRecorded>(key: K, value: CopilotRecorded[K], compare = (v: CopilotRecorded[K]): unknown => v) {
    seen[key] = value;
    if (recording) return;
    if (known === undefined) {
      differs = true;
      throw new Error(
        `no Copilot CLI recording for ${process.platform} (${recordedFile()}); TRACKWALL_RECORD=1 pnpm test:contract takes it`,
      );
    }
    try {
      expect(compare(value)).toEqual(compare(known[key]));
    } catch (err) {
      differs = true;
      throw err;
    }
  }

  return {
    async promptBox(window: Window): Promise<void> {
      const lines = (await screenLines(window)).filter((l) => l !== "");
      check("promptBox", lines.slice(-PROMPT_BOX_LINES).map(clean));
    },

    /** The approval dialog's box: from its top to its bottom border, the last one on the screen. */
    async dialogBox(window: Window): Promise<string[]> {
      const lines = await screenLines(window);
      const top = lines.findLastIndex((l) => l.startsWith("╭"));
      const bottom = lines.findLastIndex((l) => l.startsWith("╰"));
      if (top < 0 || bottom < top) throw new Error(`no dialog box on the screen:\n${lines.join("\n")}`);
      return lines.slice(top, bottom + 1).map(clean);
    },

    turn: (records: readonly CopilotHookRecord[]) => check("turn", hooks(records)),

    /** Hooks exactly; the dialog by what the daemon reads from it, since a long path wraps its lines differently. */
    approval: (records: readonly CopilotHookRecord[], dialog: string[]) =>
      check("approval", { hooks: hooks(records), dialog }, (v) => ({ hooks: v.hooks, dialog: readAgentDialog(v.dialog, "approval") })),

    exit: (records: readonly CopilotHookRecord[]) => check("exit", hooks(records)),

    titles(window: Window, prompt: string): void {
      const titles = new OscParser()
        .feed(window.text())
        .flatMap((osc) => windowTitleFromOsc(osc) ?? [])
        .map((t) => clean(t).replaceAll(prompt, PROMPT_PLACEHOLDER));
      check(
        "titles",
        titles.filter((t, i) => t !== titles[i - 1]),
      );
    },

    /** Writes the recording (`TRACKWALL_RECORD=1`), or prints the one seen when it differs. */
    finish(): void {
      const complete = CopilotRecorded.safeParse(seen);
      if (recording) {
        if (!complete.success) throw new Error(`the recording is incomplete: ${complete.error.message}`);
        mkdirSync(dirname(recordedFile()), { recursive: true });
        writeFileSync(recordedFile(), `${JSON.stringify(complete.data, null, 2)}\n`);
      } else if (differs && complete.success) {
        process.stdout.write(`Copilot CLI recording seen on ${process.platform}:\n${JSON.stringify(complete.data, null, 2)}\n`);
      }
    },
  };
}

export type Recorder = ReturnType<typeof startRecorder>;
