/**
 * What the real Copilot CLI showed and sent in the contract tests (ADR-67, ADR-69), recorded per system as a fixture in
 * `test/fixtures/copilot/recorded/<platform>.json`: the hooks of a turn, of an approved command and of `/exit` (event,
 * payload, names of the fields the record leaves out), the window titles of a turn, and the bottom of the screen with the
 * input box and the approval dialog's box, in a 100-column terminal. The fake Copilot CLI of the tests replays it, so
 * what it sends and draws comes from the real binary; the contract tests compare a live session with it, so a Copilot
 * CLI that changes any of it fails there and the recording is taken again (`TRACKWALL_RECORD=1 pnpm test:contract`).
 * Paths are replaced by `/projects` before anything is written.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CopilotHookEvent } from "../../src/modules/agents/copilot-hook-record.ts";
import { jsonOf } from "../../src/modules/agents/json.ts";

/** The terminal the recording is taken in: narrower than the session's 120 columns, so the fake's lines never wrap. */
export const RECORDED_COLS = 100;
export const RECORDED_ROWS = 30;

/** Where recorded paths point: the projects folder of the contract daemon, its repos and its state directory. */
const RECORDED_PROJECTS = "/projects";

/**
 * One hook call: the payload as the session plugin keeps it, without `sessionId` and `timestamp`, which every call has
 * and which change every time.
 */
const RecordedHook = z.object({
  event: CopilotHookEvent,
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  omitted: z.array(z.string()),
});
export type RecordedHook = z.infer<typeof RecordedHook>;

export const CopilotRecorded = z.object({
  copilotVersion: z.string(),
  platform: z.string(),
  /** The last lines of the screen of a new session waiting for its first prompt: the input box and the footer. */
  promptBox: z.array(z.string()),
  /** The window titles (OSC 0) from the start to the end of a turn; `{prompt}` stands for the prompt's text. */
  titles: z.array(z.string()),
  /** A turn that ends in text, the session's first. */
  turn: z.array(RecordedHook),
  /** A first turn with a shell command, approved with option 1, and the approval dialog's box as the screen showed it. */
  approval: z.object({ hooks: z.array(RecordedHook), dialog: z.array(z.string()) }),
  /** `/exit` after a turn. */
  exit: z.array(RecordedHook),
});
export type CopilotRecorded = z.infer<typeof CopilotRecorded>;

export const PROMPT_PLACEHOLDER = "{prompt}";

export function recordedFile(platform: string = process.platform): string {
  return join(import.meta.dir, "..", "fixtures", "copilot", "recorded", `${platform}.json`);
}

/** The recording of this system; `undefined` when none has been taken yet. */
export function readRecorded(platform: string = process.platform): CopilotRecorded | undefined {
  const file = recordedFile(platform);
  return existsSync(file) ? jsonOf(CopilotRecorded).parse(readFileSync(file, "utf8")) : undefined;
}

/** The recording of this system, which the fake Copilot CLI cannot run without. */
export function recorded(): CopilotRecorded {
  const found = readRecorded();
  if (found === undefined) throw new Error(`no Copilot CLI recording for ${process.platform}: run TRACKWALL_RECORD=1 pnpm test:contract`);
  return found;
}

/** The right border of a box line: the outer `│`, after the inner box's `│` when there is one. */
const BOX_RIGHT = /\s*│(?: │)?$/;

/**
 * Replaces `paths` (longest first) with `/projects`; a line of a box keeps its width, so its right border stays where
 * the screen had it.
 */
export function anonymize(line: string, paths: readonly string[]): string {
  let out = line;
  for (const path of [...paths].sort((a, b) => b.length - a.length)) out = out.replaceAll(path, RECORDED_PROJECTS);
  const border = BOX_RIGHT.exec(out);
  if (border === null || out.length >= line.length) return out;
  return `${out.slice(0, border.index)}${" ".repeat(line.length - out.length)}${out.slice(border.index)}`;
}
