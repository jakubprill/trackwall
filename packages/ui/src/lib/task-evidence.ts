import { countLabel, type ReproductionEvidence, type TaskEvidence, type Verification } from "@trackwall/protocol";
import { usageWithTokens } from "./copilot-usage.ts";
import type { StatusTone } from "./repo-status.ts";
import { testCountsLabel } from "./verification.ts";

/**
 * The evidence card above a task's diff (ADR-276): one row per fact Trackwall has about the change, each saying whose word
 * it is, so the reviewer sees at a glance what backs the diff they are about to read and what is missing. A check from
 * before the changes moved on loses its green and says so. No React here, so the wording is tested on its own.
 */

/**
 * Whose word a fact is: the user's own approval, the agent's claim, a check Trackwall ran itself, or what Trackwall saw
 * Copilot CLI do.
 */
export type EvidenceSource = "approval" | "claim" | "check" | "observed";

export interface EvidenceRow {
  key: "plan" | "reproduction" | "verification" | "rules" | "models";
  label: string;
  /** `ok` backs the change, `error` speaks against it, `warning` is open or outdated; none is a plain fact or a gap. */
  tone?: StatusTone;
  text: string;
  /** `null` for a gap: nobody has said anything about it yet. */
  source: EvidenceSource | null;
}

/** A running check or verification is read again soon, so its verdict shows soon after it comes. */
export function taskEvidencePollMs(evidence: TaskEvidence | undefined): number {
  const running = evidence?.verification?.state === "running" || evidence?.reproduction?.check?.state === "running";
  return running ? 2000 : 10_000;
}

const OUTDATED = "on an earlier version of the changes";

export function evidenceRows(evidence: TaskEvidence): EvidenceRow[] {
  return [
    planRow(evidence.planApproved),
    reproductionRow(evidence.reproduction),
    verificationRow(evidence.verification),
    rulesRow(evidence.rules),
    modelsRow(evidence),
  ];
}

function planRow(approved: boolean): EvidenceRow {
  return approved
    ? { key: "plan", label: "Plan", tone: "ok", text: "you approved the agent's plan before it changed files", source: "approval" }
    : { key: "plan", label: "Plan", text: "none approved: the task did not start with Plan first", source: null };
}

function reproductionRow(reproduction: ReproductionEvidence | null): EvidenceRow {
  const row = { key: "reproduction", label: "Reproduction test" } as const;
  if (reproduction === null) return { ...row, text: "none named by the agent", source: null };
  const { test, check, outdated } = reproduction;
  const claim = `${test.name}: the agent says it failed before the fix, not checked by Trackwall`;
  const reason = check?.message ? ` (${check.message})` : "";
  switch (check?.state) {
    case "reproduced":
      return outdated
        ? { ...row, tone: "warning", text: `${test.name} failed without the fix and passed with it ${OUTDATED}`, source: "check" }
        : { ...row, tone: "ok", text: `${test.name} fails without the fix and passes with it`, source: "check" };
    case "not_reproduced":
      return { ...row, tone: "error", text: `${test.name} not reproduced${outdated ? ` ${OUTDATED}` : ""}${reason}`, source: "check" };
    case "inconclusive":
      return { ...row, tone: "warning", text: `${test.name}: the check could not tell${reason}`, source: "check" };
    case "running":
      return { ...row, tone: "warning", text: `${test.name}: Trackwall is checking it`, source: "check" };
    default:
      return { ...row, tone: "warning", text: claim, source: "claim" };
  }
}

function verificationRow(verification: Verification | null): EvidenceRow {
  const row = { key: "verification", label: "Verification", source: "check" } as const;
  if (verification === null) return { ...row, text: "not run yet", source: null };
  const tests = verification.tests && verification.tests.reports > 0 ? ` · ${testCountsLabel(verification.tests.totals)}` : "";
  const what = `mise task ${verification.miseTask}${tests}`;
  if (verification.outdated) return { ...row, tone: "warning", text: `${verification.state} ${OUTDATED} (${what})` };
  switch (verification.state) {
    case "passed":
      return { ...row, tone: "ok", text: `passed (${what})` };
    case "failed":
      return { ...row, tone: "error", text: `failed (${what})` };
    case "running":
      return { ...row, tone: "warning", text: `running (mise task ${verification.miseTask})` };
    case "cancelled":
      return { ...row, text: "cancelled before a verdict", source: null };
  }
}

function rulesRow(rules: TaskEvidence["rules"]): EvidenceRow {
  const row = { key: "rules", label: "Rules check", source: "check" } as const;
  if (rules === null) return { ...row, text: "not run yet", source: null };
  const findings = rules.review.findings.length;
  const against =
    rules.review.ruleFiles.length === 0
      ? ""
      : ` against ${countLabel(rules.review.ruleFiles.length, { one: "rule file", other: "rule files" })}`;
  const result = findings === 0 ? "no findings" : countLabel(findings, { one: "finding", other: "findings" });
  if (rules.outdated) return { ...row, tone: "warning", text: `${result}${against} ${OUTDATED}` };
  return { ...row, tone: findings === 0 ? "ok" : "warning", text: `${result}${against}` };
}

/** What Copilot CLI ran the task on, the most calls first, and what its conversation used; a plain fact, not a check. */
function modelsRow({ models, usage }: TaskEvidence): EvidenceRow {
  const row = { key: "models", label: models.length > 1 ? "Models" : "Model" } as const;
  const ran = models.map((m) => `${m.model} (${countLabel(m.modelCalls, { one: "call", other: "calls" })})`).join(", ");
  const used = usage ? usageWithTokens(usage) : "";
  const text = [ran, used].filter((part) => part !== "").join(" · ");
  return text === "" ? { ...row, text: "not known yet", source: null } : { ...row, text, source: "observed" };
}
