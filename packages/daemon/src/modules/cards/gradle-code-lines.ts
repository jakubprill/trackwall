/**
 * Gradle script lines without comments (§4.6): a small scanner that skips strings, because `exclude("META-INF/*.SF")`
 * does not start a comment, and carries a block comment and a triple-quoted string over to the next lines.
 */

/** A longer line is data (generated code, an embedded file), not a dependency declaration; the expressions do not see it. */
const MAX_LINE_LENGTH = 2000;

/** Scanner state between lines: an open block comment or a triple-quoted string. */
interface ScanState {
  inBlock: boolean;
  quote: string | null;
}

/** The start of a comment or a string; a triple quote before a single one. */
const SCAN_TOKEN = /\/\*|\/\/|"""|'''|["']/g;

/**
 * Numbered lines without `//` and block `/* … *\/` comments, which in Gradle scripts often disable a dependency.
 * Strings are skipped when looking for comments, because `exclude("META-INF/*.SF")` does not start a comment. Lines
 * longer than `MAX_LINE_LENGTH` are left out of the result.
 */
export function codeLines(text: string): { text: string; number: number }[] {
  const lines: { text: string; number: number }[] = [];
  const state: ScanState = { inBlock: false, quote: null };
  text.split("\n").forEach((raw, i) => {
    const line = stripComments(raw, state);
    // A plain string ends with the line; only a triple quote crosses it.
    if (state.quote?.length === 1) state.quote = null;
    if (line.trim() !== "" && raw.length <= MAX_LINE_LENGTH) lines.push({ text: line, number: i + 1 });
  });
  return lines;
}

/** A piece of a line read in one scanner state and the position to read on from (`-1`: end of line). */
interface ScanStep {
  text: string;
  next: number;
}

/** A line without comments; `state` carries an open block comment and a string over to the next line. */
function stripComments(raw: string, state: ScanState): string {
  let out = "";
  for (let i = 0; i >= 0 && i < raw.length; ) {
    const step = state.inBlock ? skipBlock(raw, i, state) : state.quote !== null ? readString(raw, i, state) : readCode(raw, i, state);
    out += step.text;
    i = step.next;
  }
  return out;
}

function skipBlock(raw: string, from: number, state: ScanState): ScanStep {
  const end = raw.indexOf("*/", from);
  if (end < 0) return { text: "", next: -1 };
  state.inBlock = false;
  return { text: "", next: end + 2 };
}

function readString(raw: string, from: number, state: ScanState): ScanStep {
  const end = stringEnd(raw, from, state.quote ?? "");
  if (end < 0) return { text: raw.slice(from), next: -1 };
  state.quote = null;
  return { text: raw.slice(from, end), next: end };
}

/** Code up to the start of a comment (which changes the state) or a string (which stays in the result). */
function readCode(raw: string, from: number, state: ScanState): ScanStep {
  SCAN_TOKEN.lastIndex = from;
  const token = SCAN_TOKEN.exec(raw);
  if (!token) return { text: raw.slice(from), next: -1 };
  const code = raw.slice(from, token.index);
  if (token[0] === "//") return { text: code, next: -1 };
  const next = token.index + token[0].length;
  if (token[0] === "/*") {
    state.inBlock = true;
    return { text: code, next };
  }
  state.quote = token[0];
  return { text: code + token[0], next };
}

/** The index after the quote that closes the string from `from`; `-1` when it is not on this line. */
function stringEnd(raw: string, from: number, quote: string): number {
  for (let j = from; j < raw.length; j++) {
    // In a triple-quoted (raw Kotlin) string `\` is not an escape.
    if (raw[j] === "\\" && quote.length === 1) j++;
    else if (raw.startsWith(quote, j)) return j + quote.length;
  }
  return -1;
}
