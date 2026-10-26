/**
 * The Copilot CLI reference (`test/support/copilot-reference.ts`, ADR-67) taken and checked by the contract tests: each
 * test hands over what it saw, and `finish()` compares it with this system's reference once all tests are done, or,
 * with `TRACKWALL_RECORD=1`, writes it as the new reference. Nothing throws in the middle of a test, so a missing
 * reference or a difference still lets every test hand over its part, and `finish()` prints all that was seen; the
 * reference of a CI system is taken from its log that way.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { COPILOT_CLI_VERSION } from "../../scripts/copilot-cli.ts";
import { readAgentDialog } from "../../src/modules/agents/copilot-dialog.ts";
import type { CopilotHookRecord } from "../../src/modules/agents/copilot-hook-record.ts";
import { windowTitleFromOsc } from "../../src/modules/agents/copilot-osc.ts";
import { OscParser } from "../../src/modules/agents/osc-parser.ts";
import { TerminalScreen } from "../../src/modules/agents/terminal-screen.ts";
import type { viewer } from "../../test/support/agents.ts";
import {
  anonymize,
  CopilotReference,
  PROMPT_PLACEHOLDER,
  REFERENCE_COLS,
  REFERENCE_ROWS,
  type ReferenceHook,
  readReference,
  referenceFile,
} from "../../test/support/copilot-reference.ts";

type Window = ReturnType<typeof viewer>;

/** The input box, its two rules and the footer. */
const PROMPT_BOX_LINES = 4;

/** The window's screen as Copilot CLI drew it in the recording's size, once the emulator has processed all output. */
async function screenLines(window: Window): Promise<string[]> {
  const screen = new TerminalScreen(REFERENCE_COLS, REFERENCE_ROWS);
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
  const known = readReference();
  const seen: Partial<CopilotReference> = { copilotVersion: COPILOT_CLI_VERSION, platform: process.platform };
  const differences: string[] = [];
  // Copilot CLI names directories by their real path (macOS: /private/var/… for /var/…), and on Windows by the long one.
  const paths = [...new Set([daemon.projects, daemon.home].flatMap((p) => [p, realpathSync.native(p)]))];
  const clean = (text: string) => anonymize(text, paths);

  function hooks(records: readonly CopilotHookRecord[]): ReferenceHook[] {
    return records.map(({ event, payload, omitted }) => {
      const { sessionId: _, timestamp: __, ...kept } = payload;
      const cleaned = Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, typeof v === "string" ? clean(v) : v]));
      return { event, payload: cleaned, omitted: [...omitted].sort() };
    });
  }

  /** Keeps one part and notes whether it differs from the reference; `compare` maps both sides first. */
  function check<K extends keyof CopilotReference>(key: K, value: CopilotReference[K], compare = (v: CopilotReference[K]): unknown => v) {
    seen[key] = value;
    if (known !== undefined && !isDeepStrictEqual(compare(value), compare(known[key]))) {
      differences.push(`${key}: expected ${JSON.stringify(known[key])}, seen ${JSON.stringify(value)}`);
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

    /**
     * Writes the reference (`TRACKWALL_RECORD=1`; `pnpm format` then gives it the repo's JSON style), or, when there is
     * none or the session differed from it, prints what was seen and throws.
     */
    finish(): void {
      const complete = CopilotReference.safeParse(seen);
      if (recording) {
        if (!complete.success) throw new Error(`the reference is incomplete: ${complete.error.message}`);
        mkdirSync(dirname(referenceFile()), { recursive: true });
        writeFileSync(referenceFile(), `${JSON.stringify(complete.data, null, 2)}\n`);
        return;
      }
      if (known !== undefined && differences.length === 0) return;
      process.stdout.write(`Copilot CLI reference seen on ${process.platform}:\n${JSON.stringify(seen, null, 2)}\n`);
      throw new Error(
        known === undefined
          ? `no Copilot CLI reference for ${process.platform} (${referenceFile()}); TRACKWALL_RECORD=1 pnpm test:contract takes it`
          : `the session differs from the Copilot CLI reference (${referenceFile()}):\n${differences.join("\n")}`,
      );
    },
  };
}

export type Recorder = ReturnType<typeof startRecorder>;
