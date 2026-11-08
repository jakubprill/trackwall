import { isAbsolute, relative } from "node:path";
import {
  AUTO_REVIEW_FINDINGS_MAX,
  AUTO_REVIEW_TITLE_MAX,
  type AutoReviewFinding,
  AutoReviewSeverity,
  cutText,
  REVIEW_COMMENT_MAX,
  withoutInvisibleCharacters,
} from "@trackwall/protocol";

/**
 * The findings of an automatic review (ADR-182) read from the reviewer's answer. Copilot CLI's review agent reports each
 * issue in a fixed shape, which the daemon's prompt asks the reviewer to keep:
 *
 *     ## Issue: <title>
 *     **File:** <path>:<line>
 *     **Severity:** Critical | High | Medium
 *     **Problem:** <text>
 *     **Evidence:** <text>
 *     **Suggested fix:** <text>
 *
 * A check against the repo's rules (ADR-234) adds **Rule:** with the rule file and the rule it quotes, which goes into
 * the finding's text between the problem and the fix.
 *
 * The answer is model text, so nothing in it is trusted: a path outside the worktree or with `..` keeps no path, a
 * title or text is cut to its limit, and invisible characters are dropped. An answer in another shape gives no findings,
 * and the UI shows the answer itself.
 */

const ISSUE_HEADING = /^\s*#{1,4}\s*Issue\b[^:\n]*:\s*(.*)$/i;
const FIELD = /^\s*(?:[-*]\s+)?\*\*(File|Severity|Rule|Problem|Evidence|Suggested fix)\s*:?\s*\*\*\s*:?\s*(.*)$/i;
/** A Markdown rule (`---`), which ends a field. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** A line that opens or closes a Markdown code block. */
const FENCE = /^\s*(?:```|~~~)/;
/** `path:12`, `path:12-14` or `path:12:5`; the first number is the line. */
const PATH_LINE = /^(.*?):(\d+)(?:[-–:]\d+)?$/;

const FIELDS = ["file", "severity", "rule", "problem", "evidence", "suggested fix"] as const;
type Field = (typeof FIELDS)[number];

interface Block {
  title: string;
  fields: Partial<Record<Field, string[]>>;
}

/**
 * The findings of `answer`, at most `AUTO_REVIEW_FINDINGS_MAX`, with paths relative to the worktree. `worktrees` are
 * the worktree's path as the daemon knows it and as the reviewer sees it with links resolved (on macOS `/var` is
 * `/private/var`), since the reviewer writes the path its working directory has.
 */
export function reviewFindings(answer: string, worktrees: readonly string[]): AutoReviewFinding[] {
  return issueBlocks(withoutInvisibleCharacters(answer))
    .map((block) => finding(block, worktrees))
    .filter((f) => f !== null)
    .slice(0, AUTO_REVIEW_FINDINGS_MAX);
}

function issueBlocks(answer: string): Block[] {
  const blocks: Block[] = [];
  const state: ReadState = { field: null, inFence: false };
  for (const line of answer.split(/\r?\n/)) readLine(line, blocks, state);
  return blocks;
}

/** The field the lines go to, and whether they are in a code block of it. */
interface ReadState {
  field: Field | null;
  inFence: boolean;
}

function readLine(line: string, blocks: Block[], state: ReadState): void {
  const block = blocks.at(-1);
  if (state.field !== null && state.inFence) {
    block?.fields[state.field]?.push(line);
    state.inFence = !FENCE.test(line);
    return;
  }
  const heading = ISSUE_HEADING.exec(line);
  if (heading) {
    blocks.push({ title: plain(heading[1] ?? ""), fields: {} });
    state.field = null;
    return;
  }
  if (!block) return;
  const labelled = FIELD.exec(line);
  const name = FIELDS.find((f) => f === labelled?.[1]?.toLowerCase());
  if (labelled && name) {
    state.field = name;
    block.fields[name] = [labelled[2] ?? ""];
  } else if (line.trim() === "" || RULE.test(line)) {
    // A field is one paragraph: what follows a blank line or a rule is the reviewer's own text.
    state.field = null;
  } else if (state.field !== null) {
    block.fields[state.field]?.push(line);
    // A code block in a field keeps its blank lines.
    state.inFence = FENCE.test(line);
  }
}

function finding(block: Block, worktrees: readonly string[]): AutoReviewFinding | null {
  const value = (field: Field) => (block.fields[field] ?? []).join("\n").trim();
  const problem = value("problem");
  const rule = value("rule");
  const fix = value("suggested fix");
  const text = [problem, rule === "" ? "" : `Rule: ${rule}`, fix === "" ? "" : `Suggested fix: ${fix}`]
    .filter((part) => part !== "")
    .join("\n\n");
  const title = block.title === "" ? firstLine(problem) : block.title;
  if (title === "" || text === "") return null;
  const place = filePlace(plain(value("file")), worktrees);
  const severity = AutoReviewSeverity.safeParse(plain(value("severity")).toLowerCase().split(/\W/)[0]);
  return {
    title: cutText(title, AUTO_REVIEW_TITLE_MAX),
    severity: severity.success ? severity.data : null,
    path: place.path,
    line: place.line,
    text: cutText(text, REVIEW_COMMENT_MAX),
  };
}

/**
 * The file and line a finding names, the path relative to the worktree with `/`. The review agent writes absolute
 * paths (its instructions ask for them), so one inside the worktree is made relative; anything else keeps no path.
 */
function filePlace(file: string, worktrees: readonly string[]): { path: string | null; line: number | null } {
  const match = PATH_LINE.exec(file);
  const named = match ? (match[1] ?? "") : file;
  const line = match ? Number(match[2]) : null;
  const path = worktrees.map((worktree) => relativePath(named.trim(), worktree)).find((p) => p !== null) ?? null;
  return { path, line: path !== null && line !== null && line > 0 ? line : null };
}

function relativePath(named: string, worktree: string): string | null {
  if (named === "") return null;
  const inWorktree = isAbsolute(named) ? relative(worktree, named) : named;
  const parts = inWorktree.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..") || isAbsolute(inWorktree) || /^[A-Za-z]:/.test(inWorktree)) return null;
  // The contract's paths use `/` (`ChangedFile.path`), whatever separator `relative` or the model gave.
  return parts.join("/");
}

/** Without Markdown's backticks and bold around it. */
function plain(text: string): string {
  return text.replace(/^[`*\s]+|[`*\s]+$/g, "");
}

function firstLine(text: string): string {
  return plain(text.split("\n")[0] ?? "");
}
