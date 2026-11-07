/**
 * Copilot CLI's input box, read from a session's screen (§4.4, ADR-69, ADR-180): what it holds, for the daemon and the
 * session terminal alike. Copilot CLI 1.0.103 sends
 * no hook until the first prompt: `sessionStart` comes together with it. So a new session that is ready for input is
 * told only by its screen: at the bottom the input box and under it the footer with hints (`Interactive · Manual
 * Approval · / commands …`, shortened in a narrow terminal). While Copilot CLI is still loading, and while it works, the
 * footer is a status line instead, an animated bullet (● ◉ ◎ ○) and a word (`Loading: …`, `Working · …`), and the input
 * box may already be drawn, so the footer decides. The box comes in two layouts, and Copilot CLI picks one per session:
 * - ruled: a line starting with `❯` between two rules across the whole width (`─`), the default;
 * - framed (seen on 1.0.107, ADR-220): a rail on the left, `╻` over lines starting with `┃` over `╹`, its top a row of `▄` and
 *   its bottom a row of `▀`, with no `❯`. Copilot CLI draws it when its `PROMPT_FRAME` feature is on for the account
 *   (or `COPILOT_PROMPT_FRAME=1`) and the terminal answered its query for the background colour, as the session
 *   terminal's xterm.js does.
 * The daemon's tests read screens of the real binary; the contract tests check this reading on the pinned version.
 */

const RULE = /^─+$/;
/** The framed box's top and bottom, each with its end of the rail. */
const FRAME_TOP = /^╻▄+$/;
const FRAME_BOTTOM = /^╹▀+$/;
const FRAME_RAIL = "┃";
/** The footer as a status line: any one-character bullet frame, then the word. */
const STATUS = /^\S\s+(Loading|Working)\b/;

/** How many lines a wrapped input box may take: the daemon's longest prompt in a narrow terminal fits. */
const MAX_BOX_LINES = 12;

/**
 * The input box at the bottom of the visible lines (top to bottom) of an idle Copilot CLI: the text in it (`""` when
 * empty, the user's or a prompt not taken, its wrapped lines joined with single spaces), or `undefined` when the screen
 * does not end with the box over the hints footer. A text longer than the terminal is wrapped inside the box, its next
 * lines indented under the first (in the framed box, each on the rail).
 */
export function promptBoxText(lines: readonly string[]): string | undefined {
  const shown = trimmedLines(lines);
  const footer = shown.at(-1) ?? "";
  if (footer === "" || STATUS.test(footer)) return undefined;
  const layout = layoutOver(shown);
  if (layout === "ruled") return ruledBoxText(shown);
  if (layout === "framed") return framedBoxText(shown);
  return undefined;
}

export type PromptBoxLayout = "ruled" | "framed";

/**
 * The layout of the box Copilot CLI draws at the bottom of the screen over its footer, whether the footer has hints or a
 * status line, or `undefined` when the line over the footer ends neither layout.
 */
export function promptBoxLayout(lines: readonly string[]): PromptBoxLayout | undefined {
  return layoutOver(trimmedLines(lines));
}

/** The lines trimmed, without the empty ones at the bottom. */
function trimmedLines(lines: readonly string[]): string[] {
  const shown = lines.map((l) => l.trim());
  while (shown.at(-1) === "") shown.pop();
  return shown;
}

/** The layout whose bottom is the line over the footer (`shown` trimmed). */
function layoutOver(shown: readonly string[]): PromptBoxLayout | undefined {
  const bottom = shown.at(-2) ?? "";
  if (RULE.test(bottom)) return "ruled";
  if (FRAME_BOTTOM.test(bottom)) return "framed";
  return undefined;
}

/** The ruled box over the footer (`shown` trimmed): a `❯` line under a rule, its wrapped lines up to the bottom rule. */
function ruledBoxText(shown: readonly string[]): string | undefined {
  for (let first = shown.length - 3; first >= Math.max(1, shown.length - 2 - MAX_BOX_LINES); first--) {
    const line = shown.at(first) ?? "";
    if (RULE.test(line)) return undefined;
    if (!line.startsWith("❯")) continue;
    if (!RULE.test(shown.at(first - 1) ?? "")) return undefined;
    return joinBoxLines([line.slice(1), ...shown.slice(first + 1, -2)]);
  }
  return undefined;
}

/** The framed box over the footer (`shown` trimmed): every line between its top and bottom starts with the rail. */
function framedBoxText(shown: readonly string[]): string | undefined {
  const inside: string[] = [];
  for (let at = shown.length - 3; at >= Math.max(0, shown.length - 3 - MAX_BOX_LINES); at--) {
    const line = shown.at(at) ?? "";
    if (FRAME_TOP.test(line)) return inside.length === 0 ? undefined : joinBoxLines(inside);
    if (!line.startsWith(FRAME_RAIL)) return undefined;
    inside.unshift(line.slice(FRAME_RAIL.length));
  }
  return undefined;
}

/** The box's text: its wrapped lines joined with single spaces, `""` when they hold nothing. */
function joinBoxLines(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ");
}

/** The input box at the bottom of the screen: `empty`, with `text` in it, or `undefined` (`promptBoxText`). */
export function promptBoxOnScreen(lines: readonly string[]): "empty" | "text" | undefined {
  const text = promptBoxText(lines);
  if (text === undefined) return undefined;
  return text === "" ? "empty" : "text";
}
