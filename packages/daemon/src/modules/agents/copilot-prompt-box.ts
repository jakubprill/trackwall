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

/** How many lines a wrapped input box may take: the daemon's longest prompt in a narrow terminal fits. */
const MAX_BOX_LINES = 12;

/**
 * The input box at the bottom of the visible lines (top to bottom) of an idle Copilot CLI: the text in it (`""` when
 * empty, the user's or a prompt not taken, its wrapped lines joined with single spaces), or `undefined` when the screen
 * does not end with the box over the hints footer. A text longer than the terminal is wrapped inside the box, its next
 * lines indented under the first.
 */
export function promptBoxText(lines: readonly string[]): string | undefined {
  const shown = lines.map((l) => l.trim());
  while (shown.at(-1) === "") shown.pop();
  const footer = shown.at(-1) ?? "";
  if (footer === "" || STATUS.test(footer) || !RULE.test(shown.at(-2) ?? "")) return undefined;
  for (let first = shown.length - 3; first >= Math.max(1, shown.length - 2 - MAX_BOX_LINES); first--) {
    const line = shown.at(first) ?? "";
    if (RULE.test(line)) return undefined;
    if (!line.startsWith("❯")) continue;
    if (!RULE.test(shown.at(first - 1) ?? "")) return undefined;
    return [line.slice(1), ...shown.slice(first + 1, -2)]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" ");
  }
  return undefined;
}

/** The input box at the bottom of the screen: `empty`, with `text` in it, or `undefined` (`promptBoxText`). */
export function promptBoxOnScreen(lines: readonly string[]): "empty" | "text" | undefined {
  const text = promptBoxText(lines);
  if (text === undefined) return undefined;
  return text === "" ? "empty" : "text";
}

/** An idle Copilot CLI is waiting for you whether or not its box holds text. */
export function stateFromPromptBox(lines: readonly string[]): StateSignal | undefined {
  return promptBoxOnScreen(lines) === undefined ? undefined : PROMPT_BOX;
}
