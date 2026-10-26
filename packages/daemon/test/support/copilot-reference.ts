/**
 * The Copilot CLI reference (`CONTEXT.md`, ADR-67): what the real Copilot CLI showed and sent in the contract tests,
 * kept per system as a fixture in `test/fixtures/copilot/reference/<platform>.json`: the hooks of a turn, of an approved command and of `/exit` (event,
 * payload, names of the fields the record leaves out), the window titles of a turn, and the bottom of the screen with the
 * input box and the approval dialog's box, in a 100-column terminal. The fake Copilot CLI of the tests replays it, so
 * what it sends and draws comes from the real binary; the contract tests compare a live session with it, so a Copilot
 * CLI that changes any of it fails there and the reference is taken again (`TRACKWALL_RECORD=1 pnpm test:contract`).
 * Paths are replaced by `/projects` before anything is written.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CopilotHookEvent } from "../../src/modules/agents/copilot-hook-record.ts";
import { jsonOf } from "../../src/modules/agents/json.ts";

/** The terminal the reference is taken in: narrower than the session's 120 columns, so the fake's lines never wrap. */
export const REFERENCE_COLS = 100;
export const REFERENCE_ROWS = 30;

/** Where the reference's paths point: the projects folder of the contract daemon, its repos and its state directory. */
const REFERENCE_PROJECTS = "/projects";

/**
 * One hook call: the payload as the session plugin keeps it, without `sessionId` and `timestamp`, which every call has
 * and which change every time.
 */
const ReferenceHook = z.object({
  event: CopilotHookEvent,
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  omitted: z.array(z.string()),
});
export type ReferenceHook = z.infer<typeof ReferenceHook>;

export const CopilotReference = z.object({
  copilotVersion: z.string(),
  platform: z.string(),
  /** The last lines of the screen of a new session waiting for its first prompt: the input box and the footer. */
  promptBox: z.array(z.string()),
  /**
   * The window titles (OSC 0): the first at the start, the rest in order during a turn; `{prompt}` stands for the
   * prompt's text.
   */
  titles: z.array(z.string()).min(2),
  /** A turn that ends in text, the session's first. */
  turn: z.array(ReferenceHook),
  /** A first turn with a shell command, approved with option 1, and the approval dialog's box as the screen showed it. */
  approval: z.object({ hooks: z.array(ReferenceHook), dialog: z.array(z.string()) }),
  /** `/exit` after a turn. */
  exit: z.array(ReferenceHook),
});
export type CopilotReference = z.infer<typeof CopilotReference>;

export const PROMPT_PLACEHOLDER = "{prompt}";

export function referenceFile(platform: string = process.platform): string {
  return join(import.meta.dir, "..", "fixtures", "copilot", "reference", `${platform}.json`);
}

/** The reference of `platform`; `undefined` when none has been taken yet. */
export function readReference(platform: string = process.platform): CopilotReference | undefined {
  const file = referenceFile(platform);
  return existsSync(file) ? jsonOf(CopilotReference).parse(readFileSync(file, "utf8")) : undefined;
}

/** The reference of this system, which the fake Copilot CLI cannot run without. */
export function reference(): CopilotReference {
  const found = readReference();
  if (found === undefined) throw new Error(`no Copilot CLI reference for ${process.platform}: run TRACKWALL_RECORD=1 pnpm test:contract`);
  return found;
}

/** A path shortened by Copilot CLI: anything, `...` between separators, and the last part. */
const SHORTENED_PATH = /(?:[A-Za-z]:)?[\\/][^\s()]*?[\\/]\.{3}[\\/]([^\s()\\/]+)/g;

/** The right border of a box line: the outer `│`, after the inner box's `│` when there is one. */
const BOX_RIGHT = /\s*│(?: │)?$/;

/**
 * Replaces `paths` (longest first) with `/projects`, and a path Copilot CLI shortened with `...` to fit the screen
 * (`(/tmp/x/.../shop)`) with `/projects/<last part>`, so that the reference does not depend on the length of the
 * machine's temporary directory; a line of a box keeps its width, so its right border stays where the screen had it.
 */
export function anonymize(line: string, paths: readonly string[]): string {
  let out = line;
  for (const path of [...paths].sort((a, b) => b.length - a.length)) out = out.replaceAll(path, REFERENCE_PROJECTS);
  out = out.replace(SHORTENED_PATH, (_, last: string) => `${REFERENCE_PROJECTS}/${last}`);
  const border = BOX_RIGHT.exec(out);
  if (border === null || out.length === line.length) return out;
  // The blanks before the border make up for the difference, as far as there are blanks to take.
  const text = out.slice(0, border.index);
  const right = out.slice(border.index).trimStart();
  return `${text}${" ".repeat(Math.max(1, line.length - text.length - right.length))}${right}`;
}
