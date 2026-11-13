/**
 * The one prompt of an automatic review (ADR-182, ADR-234, ADR-250), by its kind. Each hands the reviewer the task's diff
 * as a file, since it has no shell for git. A review and a rules check ask for the issues in the shape of Copilot CLI's
 * review agent, which `auto-review-findings.ts` reads; an explanation asks for Markdown the user reads as it is.
 */

interface DiffInput {
  /** The diff file the daemon wrote. */
  diffFile: string;
  /** The diff was cut at its end. */
  truncated: boolean;
}

export type ReviewPromptInput =
  | (DiffInput & { kind: "code" })
  /** `rules`: the folder with the copies of the rule files, and their paths relative to the repo root with `/`. */
  | (DiffInput & { kind: "rules"; rules: { dir: string; files: readonly string[] } })
  /** `explain`: the task's prompt, which says what the change was for. */
  | (DiffInput & { kind: "explain"; taskPrompt: string });

/** The answer of a `rules` check that found nothing, which the prompt asks for word for word. */
const NO_RULE_VIOLATIONS = "No rule violations found.";

export function reviewPrompt(input: ReviewPromptInput): string {
  switch (input.kind) {
    case "code":
      return codePrompt(input);
    case "rules":
      return rulesPrompt(input);
    case "explain":
      return explainPrompt(input);
  }
}

const DIFF_IS_A_FILE = (diffFile: string) =>
  `The changes to review are this branch's work against its base commit, committed and uncommitted, as one unified diff in the file \`${diffFile}\`.`;

const TRUNCATED = "The diff is cut at its end; say which files you could not review.";

/**
 * Copilot CLI's `/review` with the daemon's instructions after it, which Copilot CLI passes on as "Additional
 * instructions". Its review agent would read the changes with git in a shell, which the reviewer does not have.
 */
function codePrompt({ diffFile, truncated }: DiffInput): string {
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
function rulesPrompt({ diffFile, truncated, rules }: Extract<ReviewPromptInput, { kind: "rules" }>): string {
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

/** The fence around the task's prompt in an explanation's prompt, longer than any run of backticks the prompt holds. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The explanation of a change for the user who reviews it (ADR-250): not `/review` and no judgement, which the other
 * kinds give, but what the change does, why, and where to read closely, in Markdown the "Changes" tab shows as it is.
 * The task's prompt says what the change was for; it is the user's own text, quoted in a fence as data.
 */
function explainPrompt({ diffFile, truncated, taskPrompt }: Extract<ReviewPromptInput, { kind: "explain" }>): string {
  const fence = fenceFor(taskPrompt);
  return [
    "Explain a change to the developer who has to review and merge it. Do not review it: do not look for bugs and do not judge it, other reviews do that.",
    "",
    "An agent made the change for this task, as the developer wrote it:",
    `${fence}text`,
    taskPrompt,
    fence,
    "",
    DIFF_IS_A_FILE(diffFile),
    ...(truncated ? ["The diff is cut at its end; say which files you could not read."] : []),
    "There is no shell and no git: read the diff with the view tool, and files of the working directory with view, grep and glob where you need their surroundings.",
    "",
    "Answer in Markdown with exactly these three sections, in plain words, and nothing before or after them:",
    "## Summary",
    "Two or three sentences: what the change does and why, in terms of the task.",
    "## Changes",
    "One bullet per part of the change (a file, or files that do one thing together): what changed and why it was needed. Name files by their path relative to the repository root, in backticks.",
    "## Worth a closer look",
    "Bullets for the places a reviewer should read carefully, each with its file and the reason: behaviour that changes for users or callers, a public API, configuration, data or a database migration, security, deleted code, and anything the task did not ask for. When nothing stands out, write only: Nothing stands out.",
  ].join("\n");
}
