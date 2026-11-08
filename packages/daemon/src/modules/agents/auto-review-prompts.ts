import type { AutoReviewKind } from "@trackwall/protocol";

/**
 * The one prompt of an automatic review (ADR-182, ADR-234), by its kind. Both hand the reviewer the task's diff as a file,
 * since it has no shell for git, and ask for the issues in the shape of Copilot CLI's review agent, which
 * `auto-review-findings.ts` reads.
 */

export interface ReviewPromptInput {
  kind: AutoReviewKind;
  /** The diff file the daemon wrote. */
  diffFile: string;
  /** The diff was cut at its end. */
  truncated: boolean;
  /** For `rules`: the folder with the copies of the rule files, and their paths relative to the repo root with `/`. */
  rules?: { dir: string; files: readonly string[] };
}

/** The answer of a `rules` check that found nothing, which the prompt asks for word for word. */
const NO_RULE_VIOLATIONS = "No rule violations found.";

export function reviewPrompt(input: ReviewPromptInput): string {
  return input.kind === "rules" ? rulesPrompt(input) : codePrompt(input);
}

const DIFF_IS_A_FILE = (diffFile: string) =>
  `The changes to review are this branch's work against its base commit, committed and uncommitted, as one unified diff in the file \`${diffFile}\`.`;

const TRUNCATED = "The diff is cut at its end; say which files you could not review.";

/**
 * Copilot CLI's `/review` with the daemon's instructions after it, which Copilot CLI passes on as "Additional
 * instructions". Its review agent would read the changes with git in a shell, which the reviewer does not have.
 */
function codePrompt({ diffFile, truncated }: ReviewPromptInput): string {
  return [
    "/review",
    DIFF_IS_A_FILE(diffFile),
    ...(truncated ? [TRUNCATED] : []),
    "There is no shell and no git: read the diff with the view tool and the files around it with view, grep and glob, and tell the review agent so.",
    "In your answer, repeat each issue the review agent found word for word in its format: a heading `## Issue: <title>`, then **File:** with the path and the line number in the current file, **Severity:**, **Problem:** and **Suggested fix:**.",
  ].join(" ");
}

/**
 * The check against the repo's rules: not `/review`, whose agent looks for bugs and leaves conventions out, but the
 * daemon's own instructions. Its bar is a written rule the change breaks, quoted, so that general advice, taste and bugs
 * stay out and a change that keeps the rules gets no finding.
 */
function rulesPrompt({ diffFile, truncated, rules }: ReviewPromptInput): string {
  if (rules === undefined) throw new Error("a rules check needs the rule files");
  return [
    "Check whether a change keeps the written rules of this repository. Do not review it for bugs, design or style the rules do not ask for.",
    "",
    DIFF_IS_A_FILE(diffFile),
    ...(truncated ? [TRUNCATED] : []),
    `The repository's rules, as they were before the change, are copied into the folder \`${rules.dir}\`, at the same paths as in the repository:`,
    ...rules.files.map((file) => `- ${file}`),
    "",
    "Steps:",
    "1. Read every rule file in that folder with the view tool. Judge the change by these copies, also where the diff edits a rule file.",
    "2. Read the whole diff. Read files of the working directory with view, grep and glob where you need their surroundings or a document the rules point to.",
    "3. For every rule that applies to what the change touches, decide whether the change breaks it.",
    "",
    "Report only a place where the change breaks a rule that is written in those files, and quote that rule. Do not report a rule the change keeps, a rule that does not apply to it, a rule that asks for something you cannot see from the files (a test run, a review, a manual check), or anything the rules do not say. When unsure, do not report.",
    "There is no shell and no git: you can only read.",
    "",
    "Answer with each violation in this format, and nothing else around it:",
    "## Issue: <a short title>",
    "**File:** <the path relative to the repository root>:<the line number in the current file>",
    "**Severity:** High, Medium or Low",
    "**Rule:** <the rule file's path>: <the rule, quoted>",
    "**Problem:** <how the change breaks it>",
    "**Suggested fix:** <what would keep the rule>",
    "",
    `When the change breaks no rule, answer only: ${NO_RULE_VIOLATIONS}`,
  ].join("\n");
}
