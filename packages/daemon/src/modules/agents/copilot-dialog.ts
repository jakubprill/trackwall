import type { AgentApproval, AgentDialog, AgentDialogOption, AgentQuestion } from "@trackwall/protocol";

/**
 * The agent dialog read from the session's screen image (§4.4, ADR-66). Copilot CLI 1.0.103 draws an approval request
 * as a box: a heading, a rule, what it asks about (the command in an inner box, or the file and its lines), the question,
 * numbered options and the footer "↑/↓ to navigate · enter to select · esc to cancel". A question from the agent
 * (`ask_user`) is a form under "Copilot needs information." with the footer "… enter accept …". The text comes from the
 * agent and the user's repo, so only the plain text of the screen is read, cut, and never interpreted beyond its layout.
 *
 * Copilot CLI wraps long lines itself, so a question or an option label can span several screen lines; they are joined
 * again. Both layouts were taken from the real binary (fixtures in `test/fixtures/copilot/`); a layout this reader does
 * not recognise is no dialog, and the user answers in the terminal as before. The id is not read here: it belongs to
 * the wait the dialog answers (`LiveSession`), since the agent can ask the same thing twice.
 *
 * An approval taller than the terminal (the JSON arguments of an MCP tool in a short task terminal) loses its top:
 * Copilot CLI keeps its tab bar on the first line and a blank line under it, and the box below them is cut above. The
 * question, options and footer are still there, so such a box counts when only the first line (the tab bar, not
 * checked) and blank lines are above its left border, which runs unbroken up from the footer; the heading is then gone, and the approval's text from its
 * notification hook stands in.
 */

/** A dialog as read from the screen, before it gets the id of its wait. */
export type ScreenDialog = Omit<AgentApproval, "id"> | Omit<AgentQuestion, "id">;

const APPROVAL_FOOTER = "enter to select";
const QUESTION_HEADING = "Copilot needs information.";
const QUESTION_FOOTER = "enter accept";
/** An option line: an optional selection marker, the digit and the label. */
const OPTION = /^(❯\s*)?([1-9])\.\s+(.*)$/;
/** An option that needs text typed in the terminal, so it cannot be answered with its digit alone. */
const NEEDS_TEXT = /^No\b/;
/** Lines made only of box drawing and spaces (the inner box's top and bottom, the rule under the heading). */
const BOX_ONLY = /^[\s╭╮╰╯─│]*$/;
const MAX_DETAIL_LINES = 20;
/** The heading of a cut box whose notification hook brought no text. */
const CUT_BOX_TITLE = "Approval request";
/** The first detail line of a cut box: the detail starts in the middle of what the dialog shows. */
const CUT_DETAIL = "…";
const MAX_TEXT = 300;

/**
 * The dialog of `kind` on the screen (its visible lines, top to bottom), or `undefined` when there is none or its layout
 * is unknown. Only the kind the session's state waits for is read, so an approval not cleared yet hides no question.
 * `notice` is the text of the approval's notification hook ("Use MCP tool: …"), the heading of a box cut above.
 */
export function readAgentDialog(lines: readonly string[], kind: AgentDialog["kind"], notice?: string): ScreenDialog | undefined {
  // Copilot CLI indents the lines of a file diff with no-break spaces.
  const plain = lines.map((l) => l.replaceAll("\u00a0", " "));
  return kind === "approval" ? readApproval(plain, notice) : readQuestion(plain);
}

function readApproval(lines: readonly string[], notice: string | undefined): ScreenDialog | undefined {
  const footer = lines.findLastIndex((l) => l.includes(APPROVAL_FOOTER));
  if (footer < 0) return undefined;
  const box = approvalBox(lines.slice(0, footer));
  if (!box) return undefined;
  const { body } = box;
  // The rule under the heading.
  if (body[0] !== undefined && body[0].trim() !== "" && BOX_ONLY.test(body[0])) body.shift();
  const paragraphs = split(body);
  const options = readOptions(paragraphs.pop() ?? []);
  const cutAbove = box.heading === undefined;
  const title = cut((box.heading ?? notice ?? CUT_BOX_TITLE).trim());
  const question = cut(joinWrapped(paragraphs.pop() ?? []));
  if (!title || !question || !options?.length) return undefined;
  const answerable = options.filter((o) => !NEEDS_TEXT.test(o.label));
  // The selection moved to an option that takes text (it may already be taking it), so a digit would not answer.
  if (options.some((o) => o.selected && !answerable.includes(o))) return undefined;
  // A cut box's detail starts with "…", which takes the place of its last line rather than of the one nearest the question.
  const detail = detailLines(paragraphs, cutAbove ? MAX_DETAIL_LINES - 1 : MAX_DETAIL_LINES);
  return {
    kind: "approval",
    title,
    detail: cutAbove ? [CUT_DETAIL, ...detail] : detail,
    question,
    options: answerable.map(({ key, label }) => ({ key, label })),
  };
}

/**
 * The box's heading and the lines under it, without its borders, from the screen lines above the footer. The dialog's
 * box starts in the first column; the agent's output, which could imitate it, is indented. A box cut above has no
 * heading (`undefined`).
 */
function approvalBox(above: readonly string[]): { heading: string | undefined; body: string[] } | undefined {
  const top = above.findLastIndex((l) => l.startsWith("╭"));
  if (top >= 0) {
    const [heading = "", ...body] = above.slice(top + 1).map(insideBox);
    return { heading, body };
  }
  // Cut above: only the first line (the tab bar) and blank lines above the box's left border.
  const border = above.findLastIndex((l) => !l.startsWith("│")) + 1;
  const cutAbove = above.slice(1, border).every((l) => l.trim() === "");
  return cutAbove ? { heading: undefined, body: above.slice(border).map(insideBox) } : undefined;
}

/** The paragraphs between the rule and the question, without the inner box around a command. */
function detailLines(paragraphs: readonly string[][], max: number): string[] {
  return paragraphs
    .flatMap((p, i) => (i === 0 ? p : ["", ...p]))
    .map((l) => insideBox(l).trimEnd())
    .filter((l) => l === "" || !BOX_ONLY.test(l))
    .slice(0, max)
    .map(cut);
}

function readQuestion(lines: readonly string[]): ScreenDialog | undefined {
  const heading = lines.findLastIndex((l) => l.trim() === QUESTION_HEADING);
  if (heading < 0 || !lines.slice(heading).some((l) => l.includes(QUESTION_FOOTER))) return undefined;
  const asked: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    const text = line.trim();
    // The empty line before the first form field ("Database:") ends the question, as in every form seen on the binary.
    if (text === "" || text.startsWith("❯") || text.includes(QUESTION_FOOTER)) break;
    asked.push(text);
  }
  const question = cut(joinWrapped(asked));
  if (!question) return undefined;
  return { kind: "question", question };
}

/** An option and whether the selection marker is on it. */
type ScreenOption = AgentDialogOption & { selected: boolean };

/** The options of the last paragraph; `undefined` when a line before the first option is not one (not an option list). */
function readOptions(lines: readonly string[]): ScreenOption[] | undefined {
  const options: { key: string; selected: boolean; parts: string[] }[] = [];
  for (const line of lines) {
    const match = OPTION.exec(line.trim());
    const last = options.at(-1);
    if (match?.[2] !== undefined) options.push({ key: match[2], selected: match[1] !== undefined, parts: [match[3] ?? ""] });
    else if (last) last.parts.push(line.trim());
    else return undefined;
  }
  return options.map((o) => ({ key: o.key, selected: o.selected, label: cut(joinWrapped(o.parts)) }));
}

/** A line of the dialog box without its left and right border. */
function insideBox(line: string): string {
  return line.replace(/^\s*│ ?/, "").replace(/ ?│\s*$/, "");
}

/** Lines into paragraphs separated by empty lines. */
function split(lines: readonly string[]): string[][] {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === "") paragraphs.push([]);
    else paragraphs.at(-1)?.push(line);
  }
  return paragraphs.filter((p) => p.length > 0);
}

/** Lines Copilot CLI wrapped, joined again: without a space after a hyphen or a slash, where it breaks paths. */
function joinWrapped(lines: readonly string[]): string {
  return lines.map((l) => l.trim()).reduce((text, line) => (text === "" ? line : /[-/]$/.test(text) ? text + line : `${text} ${line}`), "");
}

function cut(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}
