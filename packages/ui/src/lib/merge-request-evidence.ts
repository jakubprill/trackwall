import {
  type AutoReview,
  countLabel,
  type ReproductionEvidence,
  reproTestLine,
  type Task,
  type TaskEvidence,
  type Verification,
} from "@trackwall/protocol";
import { usageWithTokens } from "./copilot-usage.ts";
import { testCountsLabel } from "./verification.ts";

/**
 * The "Evidence from Trackwall" lines of a merge request's draft (ADR-238): what Trackwall itself saw of the change, each
 * worded as whose word it is, so the reviewer can tell Trackwall's checks from the agent's claims. No React here, so the
 * wording is tested on its own.
 */

/** Findings of a rules check named one by one; the rest are counted. */
const RULES_FINDINGS_SHOWN = 5;
/** Rule files named in the rules line; the rest are counted. */
const RULE_FILES_SHOWN = 3;
const EARLIER = " on an earlier version of the changes";

/**
 * The lines, each a Markdown list item, in the order the work happened; empty when Trackwall has nothing to add. They
 * word the task's evidence (ADR-276), or, when its read failed, what the task panel knows: the task and its verification.
 */
export function evidenceLines(task: Task, verification: Verification | null, evidence: TaskEvidence | null): string[] {
  const facts = evidence ?? panelEvidence(task, verification);
  return [
    facts.planApproved ? "Plan first: the user approved the agent's plan in Trackwall before it changed files" : null,
    facts.reproduction && reproductionLine(facts.reproduction),
    facts.verification && facts.verification.state !== "running" ? verificationLine(facts.verification) : null,
    facts.rules ? rulesLine(facts.rules.review, facts.rules.outdated) : null,
    modelLine(task, facts),
  ].flatMap((line) => (line ? [`- ${line}`] : []));
}

/** The evidence the task panel has without the daemon's: the plan, the agent's word on its test and the verification. */
function panelEvidence(task: Task, verification: Verification | null): TaskEvidence {
  const test = task.summary?.reproTest ?? null;
  return {
    task: task.id,
    planApproved: task.plan === "approved",
    reproduction: test && { test, check: null, outdated: false },
    verification,
    rules: null,
    usage: null,
    models: [],
  };
}

/**
 * Trackwall's verdict on the agent's reproduction test (ADR-227), else the agent's word (ADR-222): a check still running
 * or stopped says nothing yet. The evidence holds only a check of the test the agent names now.
 */
function reproductionLine({ test, check, outdated }: ReproductionEvidence): string {
  const subject = `Reproduction test ${test.name} in ${test.file}`;
  const reason = check?.message ? ` (${check.message})` : "";
  const earlier = outdated ? EARLIER : "";
  const claim = `the agent says it failed before the fix with: ${test.failure}`;
  switch (check?.state) {
    case "reproduced":
      return `${subject}: Trackwall checked${earlier} that it fails on the base commit and passes with the change`;
    case "not_reproduced":
      return `${subject}: Trackwall's check${earlier} did not confirm it${reason}; ${claim}`;
    case "inconclusive":
      return `${subject}: Trackwall's check could not tell${reason}; ${claim}`;
    default:
      return reproTestLine(test);
  }
}

/**
 * `Verification: passed (mise task test, 128 tests · 3 skipped)`; an outdated one (ADR-209) says the changes moved on
 * after it, so the reviewer does not take it for a verdict on what they read.
 */
function verificationLine(verification: Verification): string {
  const tests = verification.tests && verification.tests.reports > 0 ? `, ${testCountsLabel(verification.tests.totals)}` : "";
  const outdated = verification.outdated ? EARLIER : "";
  return `Verification: ${verification.state}${outdated} (mise task ${verification.miseTask}${tests})`;
}

/** The rules check (ADR-234): the rule files it read and its findings, each with where it is. */
function rulesLine(review: AutoReview, outdated: boolean): string {
  const files = review.ruleFiles;
  const named = files.slice(0, RULE_FILES_SHOWN).join(", ");
  const more = files.length > RULE_FILES_SHOWN ? ` and ${files.length - RULE_FILES_SHOWN} more` : "";
  const head = `Rules check against ${named}${more}${outdated ? EARLIER : ""}`;
  if (review.findings.length === 0) return `${head}: no findings`;
  const shown = review.findings.slice(0, RULES_FINDINGS_SHOWN).map((finding) => {
    const place = finding.path === null ? "" : ` (${finding.path}${finding.line === null ? "" : `:${finding.line}`})`;
    return `\n  - ${finding.title}${place}`;
  });
  const rest = review.findings.length - shown.length;
  const others = rest > 0 ? `\n  - and ${countLabel(rest, { one: "more finding", other: "more findings" })}` : "";
  return `${head}: ${countLabel(review.findings.length, { one: "finding", other: "findings" })}${shown.join("")}${others}`;
}

/**
 * The models Copilot CLI ran the task on, the most calls first, and the one asked for when it ran on none of them
 * (ADR-225), then what the conversation used; `null` when Trackwall knows neither.
 */
function modelLine(task: Task, { models, usage }: TaskEvidence): string | null {
  const calls = { one: "call", other: "calls" };
  const ran = models.map((m) => `${m.model} (${countLabel(m.modelCalls, calls)})`).join(", ");
  const asked = task.model !== null && models.length > 0 && !models.some((m) => m.model === task.model) ? `, asked for ${task.model}` : "";
  const label = models.length === 1 ? "Model" : "Models";
  const used = usage ? `${usageWithTokens(usage)} in ${countLabel(usage.modelCalls, { one: "model call", other: "model calls" })}` : "";
  if (ran === "" && used === "") return null;
  if (ran === "") return `Used: ${used}`;
  return `${label}: ${ran}${asked}${used === "" ? "" : `; used ${used}`}`;
}
