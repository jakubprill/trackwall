import { createHash } from "node:crypto";
import type { AgentDialog, AgentDialogOption } from "@trackwall/protocol";

/**
 * The agent dialog read from the session's screen image (§4.4, ADR-66). Copilot CLI 1.0.103 draws an approval request
 * as a box: a heading, a rule, what it asks about (the command in an inner box, or the file and its lines), the question,
 * numbered options and the footer "↑/↓ to navigate · enter to select · esc to cancel". A question from the agent
 * (`ask_user`) is a form under "Copilot needs information." with the footer "… enter accept …". The text comes from the
 * agent and the user's repo, so only the plain text of the screen is read, cut, and never interpreted beyond its layout.
 *
 * Copilot CLI wraps long lines itself, so a question or an option label can span several screen lines; they are joined
 * again. Both layouts were taken from the real binary (fixtures in `test/fixtures/copilot/`); a layout this reader does
 * not recognise is no dialog, and the user answers in the terminal as before.
 */

const APPROVAL_FOOTER = "enter to select";
const QUESTION_HEADING = "Copilot needs information.";
const QUESTION_FOOTER = "enter accept";
/** An option line: an optional selection marker, the digit and the label. */
const OPTION = /^(?:❯\s*)?([1-9])\.\s+(.*)$/;
/** An option that needs text typed in the terminal, so it cannot be answered with its digit alone. */
const NEEDS_TEXT = /^No\b/;
/** Lines made only of box drawing and spaces (the inner box's top and bottom, the rule under the heading). */
const BOX_ONLY = /^[\s╭╮╰╯─│]*$/;
const MAX_DETAIL_LINES = 20;
const MAX_TEXT = 300;

/** The dialog on the screen (its visible lines, top to bottom), or `undefined` when there is none or its layout is unknown. */
export function readAgentDialog(lines: readonly string[]): AgentDialog | undefined {
  // Copilot CLI indents the lines of a file diff with no-break spaces.
  const plain = lines.map((l) => l.replaceAll("\u00a0", " "));
  return readApproval(plain) ?? readQuestion(plain);
}

function readApproval(lines: readonly string[]): AgentDialog | undefined {
  const footer = lastIndex(lines, (l) => l.includes(APPROVAL_FOOTER));
  if (footer < 0) return undefined;
  const top = lastIndex(lines.slice(0, footer), (l) => l.trimStart().startsWith("╭"));
  if (top < 0) return undefined;
  const [heading = "", ...body] = lines.slice(top + 1, footer).map(insideBox);
  // The rule under the heading.
  if (body[0] !== undefined && body[0].trim() !== "" && BOX_ONLY.test(body[0])) body.shift();
  const paragraphs = split(body);
  const options = readOptions(paragraphs.pop() ?? []);
  const title = cut(heading.trim());
  const question = cut(joinWrapped(paragraphs.pop() ?? []));
  if (!title || !question || !options?.length) return undefined;
  const answerable = options.filter((o) => !NEEDS_TEXT.test(o.label));
  return withId({ kind: "approval", title, detail: detailLines(paragraphs), question, options: answerable });
}

/** The paragraphs between the rule and the question, without the inner box around a command. */
function detailLines(paragraphs: readonly string[][]): string[] {
  return paragraphs
    .flatMap((p, i) => (i === 0 ? p : ["", ...p]))
    .map((l) => insideBox(l).trimEnd())
    .filter((l) => l === "" || !BOX_ONLY.test(l))
    .slice(0, MAX_DETAIL_LINES)
    .map(cut);
}

function readQuestion(lines: readonly string[]): AgentDialog | undefined {
  const heading = lastIndex(lines, (l) => l.trim() === QUESTION_HEADING);
  if (heading < 0 || !lines.slice(heading).some((l) => l.includes(QUESTION_FOOTER))) return undefined;
  const asked: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    const text = line.trim();
    // The first form field ("Database:") or its choices end the question.
    if (text === "" || text.endsWith(":") || text.startsWith("❯") || text.includes(QUESTION_FOOTER)) break;
    asked.push(text);
  }
  const question = cut(joinWrapped(asked));
  if (!question) return undefined;
  return withId({ kind: "question", title: QUESTION_HEADING, detail: [], question, options: [] });
}

/** The options of the last paragraph; `undefined` when a line before the first option is not one (not an option list). */
function readOptions(lines: readonly string[]): AgentDialogOption[] | undefined {
  const options: { key: string; parts: string[] }[] = [];
  for (const line of lines) {
    const match = OPTION.exec(line.trim());
    const last = options.at(-1);
    if (match?.[1] !== undefined) options.push({ key: match[1], parts: [match[2] ?? ""] });
    else if (last) last.parts.push(line.trim());
    else return undefined;
  }
  return options.map((o) => ({ key: o.key, label: cut(joinWrapped(o.parts)) }));
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

function lastIndex(lines: readonly string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i] ?? "")) return i;
  return -1;
}

function withId(dialog: Omit<AgentDialog, "id">): AgentDialog {
  const id = createHash("sha256").update(JSON.stringify(dialog)).digest("hex").slice(0, 16);
  return { id, ...dialog };
}
