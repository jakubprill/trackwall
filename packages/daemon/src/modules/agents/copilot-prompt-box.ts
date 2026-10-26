import type { StateSignal } from "./task-state-tracker.ts";

/**
 * Copilot CLI waiting in its input box, read from the session's screen image (§4.4, ADR-69). Copilot CLI 1.0.103 sends
 * no hook until the first prompt: `sessionStart` comes together with it. So a new session that is ready for input is
 * told only by its screen: at the bottom the input box (a line starting with `❯` between two rules across the whole
 * width) and under it the footer with hints (`Interactive · Manual Approval · / commands …`, shortened in a narrow
 * terminal). While Copilot CLI is still loading, and while it works, the footer is a status line instead, an animated
 * bullet (● ◉ ◎ ○) and a word (`Loading: …`, `Working · …`), and the input box may already be drawn, so the footer
 * decides. Screens of the real binary are the fixtures in `test/fixtures/copilot/`; the contract tests check this
 * reading on the pinned version.
 */

const RULE = /^─+$/;
/** The footer as a status line: any one-character bullet frame, then the word. */
const STATUS = /^\S\s+(Loading|Working)\b/;

/** The input box of a session that has no state yet: waiting for you, like the end of a turn. */
const PROMPT_BOX: StateSignal = {
  state: "Input",
  source: "screen",
  confidence: "medium",
  reason: "screen input box before the first prompt",
};

/**
 * The input box at the bottom of the visible lines (top to bottom) of an idle Copilot CLI: `empty`, with `text` in it
 * (the user's, or a prompt not taken), or `undefined` when the screen does not end with the box over the hints footer.
 */
export function promptBoxOnScreen(lines: readonly string[]): "empty" | "text" | undefined {
  const shown = lines.map((l) => l.trim());
  while (shown.at(-1) === "") shown.pop();
  // A screen of fewer lines leaves the first names empty (no rule), or only the footer (three lines ending in a rule).
  const [top = "", box = "", bottom = "", footer = ""] = shown.slice(-4);
  if (!RULE.test(top) || !box.startsWith("❯") || !RULE.test(bottom) || footer === "" || STATUS.test(footer)) return undefined;
  return box === "❯" ? "empty" : "text";
}

/** An idle Copilot CLI is waiting for you whether or not its box holds text. */
export function stateFromPromptBox(lines: readonly string[]): StateSignal | undefined {
  return promptBoxOnScreen(lines) === undefined ? undefined : PROMPT_BOX;
}
