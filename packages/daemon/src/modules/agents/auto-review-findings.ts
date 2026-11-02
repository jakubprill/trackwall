import { isAbsolute, relative, sep } from "node:path";
import {
  AUTO_REVIEW_FINDINGS_MAX,
  AUTO_REVIEW_TITLE_MAX,
  type AutoReviewFinding,
  AutoReviewSeverity,
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
 * The answer is model text, so nothing in it is trusted: a path outside the worktree or with `..` keeps no path, a
 * title or text is cut to its limit, and invisible characters are dropped. An answer in another shape gives no findings,
 * and the UI shows the answer itself.
 */

const ISSUE_HEADING = /^\s*#{1,4}\s*Issue\b[^:\n]*:\s*(.*)$/i;
const FIELD = /^\s*(?:[-*]\s+)?\*\*(File|Severity|Problem|Evidence|Suggested fix)\s*:?\s*\*\*\s*:?\s*(.*)$/i;
/** `path:12`, `path:12-14` or `path:12:5`; the first number is the line. */
const PATH_LINE = /^(.*?):(\d+)(?:[-–:]\d+)?$/;

const FIELDS = ["file", "severity", "problem", "evidence", "suggested fix"] as const;
type Field = (typeof FIELDS)[number];

interface Block {
  title: string;
  fields: Partial<Record<Field, string[]>>;
}

/** The findings of `answer`, at most `AUTO_REVIEW_FINDINGS_MAX`, with paths relative to `worktree`. */
export function reviewFindings(answer: string, worktree: string): AutoReviewFinding[] {
  return issueBlocks(withoutInvisibleCharacters(answer))
    .map((block) => finding(block, worktree))
    .filter((f) => f !== null)
    .slice(0, AUTO_REVIEW_FINDINGS_MAX);
}

function issueBlocks(answer: string): Block[] {
  const blocks: Block[] = [];
  let field: Field | null = null;
  for (const line of answer.split(/\r?\n/)) {
    const heading = ISSUE_HEADING.exec(line);
    if (heading) {
      blocks.push({ title: plain(heading[1] ?? ""), fields: {} });
      field = null;
      continue;
    }
    const block = blocks.at(-1);
    if (!block) continue;
    const labelled = FIELD.exec(line);
    const name = FIELDS.find((f) => f === labelled?.[1]?.toLowerCase());
    if (labelled && name) {
      field = name;
      block.fields[name] = [labelled[2] ?? ""];
    } else if (line.trim() === "" || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      // A field is one paragraph: what follows a blank line or a rule is the reviewer's own text.
      field = null;
    } else if (field !== null) {
      block.fields[field]?.push(line);
    }
  }
  return blocks;
}

function finding(block: Block, worktree: string): AutoReviewFinding | null {
  const value = (field: Field) => (block.fields[field] ?? []).join("\n").trim();
  const problem = value("problem");
  const fix = value("suggested fix");
  const text = [problem, fix === "" ? "" : `Suggested fix: ${fix}`].filter((part) => part !== "").join("\n\n");
  const title = block.title === "" ? firstLine(problem) : block.title;
  if (title === "" || text === "") return null;
  const place = filePlace(plain(value("file")), worktree);
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
function filePlace(file: string, worktree: string): { path: string | null; line: number | null } {
  const match = PATH_LINE.exec(file);
  const named = match ? (match[1] ?? "") : file;
  const line = match ? Number(match[2]) : null;
  const path = relativePath(named.trim(), worktree);
  return { path, line: path !== null && line !== null && line > 0 ? line : null };
}

function relativePath(named: string, worktree: string): string | null {
  if (named === "") return null;
  const inWorktree = isAbsolute(named) ? relative(worktree, named) : named;
  const parts = inWorktree.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..") || isAbsolute(inWorktree) || /^[A-Za-z]:/.test(inWorktree)) return null;
  // `relative` gives `sep`, a path from the model `/`; the contract's paths use `/` (`ChangedFile.path`).
  return parts.join("/").split(sep).join("/");
}

/** Without Markdown's backticks and bold around it. */
function plain(text: string): string {
  return text.replace(/^[`*\s]+|[`*\s]+$/g, "");
}

function firstLine(text: string): string {
  return plain(text.split("\n")[0] ?? "");
}

/** Cut to `max` characters with "…", never between the two halves of a character outside the BMP. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept}…`;
}
