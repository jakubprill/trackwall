import type {
  AgentSession,
  ChangedFile,
  GetSessionResult,
  JavaNavigationStatus,
  LogError,
  Task,
  TaskChangesSummary,
  TestFailure,
  Verification,
} from "@trackwall/protocol";
import { countLabel, GET_SESSION_PROMPT_ARG, modelSwitch, reproTestLine } from "@trackwall/protocol";

const COMMITS = { one: "commit", other: "commits" };
const FILES = { one: "file", other: "files" };
const MORE_LINES = { one: "more line", other: "more lines" };
const MODEL_CALLS = { one: "model call", other: "model calls" };
const VARIABLES = { one: "variable", other: "variables" };
const SECRETS = { one: "secret", other: "secrets" };
const TESTS = { one: "test", other: "tests" };
const FAILURES = { one: "failure", other: "failures" };
const ERRORS = { one: "error", other: "errors" };
const REPORTS = { one: "report", other: "reports" };

/** One letter per change, as in `git status --short`. */
const CHANGE_LETTER: Record<ChangedFile["change"], string> = { added: "A", modified: "M", deleted: "D" };

/**
 * The text of the `get_session` result, which is all the model behind Copilot CLI reads of it (ADR-187, ADR-207): a
 * supervisor reads it after every turn and report of its tasks, and each result stays in its context for every later
 * model call. So the facts it acts on go on short lines instead of JSON that repeats every field name; the task's prompt,
 * which the proposer wrote itself, comes only when asked for (`GET_SESSION_PROMPT_ARG`); what an agent never acts on
 * (the session view, the names of the environment's variables, run ids, report paths) is left out.
 */
export function sessionText(result: GetSessionResult, withPrompt: boolean): string {
  const lines = sessionLines(result.session);
  if (result.task !== null) lines.push(...taskLines(result.task, withPrompt), ...changesLines(result.changes, result.changesError));
  if (result.verification !== null) lines.push(...verificationLines(result.verification));
  if (result.javaNavigation !== null) lines.push(`Java navigation: ${javaNavigationLabel(result.javaNavigation)}`);
  return lines.join("\n");
}

/** The model after the session's head: the one Trackwall asked for, and the one Copilot CLI took when it differs (ADR-225). */
function modelText(session: AgentSession): string {
  const switched = modelSwitch(session);
  if (switched !== null) return ` on ${switched.inUse} instead of ${switched.requested}`;
  return session.model === null ? "" : ` on ${session.model}`;
}

function sessionLines(session: AgentSession): string[] {
  const where = session.supervisor ? "supervisor" : session.task !== null ? `task ${session.task}` : (session.repo ?? "no repo");
  const repo = session.task !== null && session.repo !== null ? ` in ${session.repo}` : "";
  const model = modelText(session);
  const lines = [`Session ${session.id} (${where}${repo})${model}: ${runLabel(session.run)}`];
  if (session.state !== null) {
    const { state, source, confidence, at, reason } = session.state;
    lines.push(`State: ${state} at ${at} (${source}, ${confidence}): ${reason}`);
  }
  if (session.needsAttention) lines.push("Needs attention: it waits for the user or for input.");
  if (session.stuck !== null) lines.push(`May be stuck: no step since ${session.stuck.lastStepAt}.`);
  // A turn whose model call failed ends without an answer (ADR-242); on a model the account lacks, every later one too.
  if (session.modelError !== null) lines.push(`Its last model call failed: ${session.modelError}`);
  if (session.readRequest !== null)
    lines.push(`Asked to read what waits for it since ${session.readRequest.since} (${session.readRequest.waitsFor}).`);
  if (session.windowTitle !== null) lines.push(`Window title: ${session.windowTitle}`);
  lines.push(...environmentLines(session.environment));
  if (session.usage !== null) lines.push(`Usage: ${usageLabel(session.usage)}`);
  if (session.tokenBudget !== null) lines.push(tokenBudgetLine(session.tokenBudget));
  return lines;
}

function runLabel(run: AgentSession["run"]): string {
  if (run.kind !== "exited") return `${run.kind} since ${run.startedAt}`;
  const end = run.signal !== null ? `signal ${run.signal}` : `exit code ${run.exitCode ?? "unknown"}`;
  return `exited at ${run.endedAt} (${end}${run.stoppedByUser ? ", stopped by the user" : ""})`;
}

function environmentLines(environment: AgentSession["environment"]): string[] {
  const facts = [
    environment.profile === null ? undefined : `profile ${environment.profile}`,
    environment.variables.length > 0 ? countLabel(environment.variables.length, VARIABLES) : undefined,
    environment.secrets.length > 0 ? countLabel(environment.secrets.length, SECRETS) : undefined,
    environment.agentSecrets.length > 0 ? `agent secrets ${environment.agentSecrets.join(", ")}` : undefined,
    environment.problem === null ? undefined : `problem: ${environment.problem}`,
  ].filter((fact) => fact !== undefined);
  return facts.length === 0 ? [] : [`Environment: ${facts.join("; ")}`];
}

/** A task's token budget (ADR-237): what this start used of it, and whether the daemon stopped the session for it. */
function tokenBudgetLine({ budget, used, reached }: NonNullable<AgentSession["tokenBudget"]>): string {
  const stop = reached ? "; Trackwall stopped the session at it, and only the user's Resume gives the task the budget again" : "";
  return `Token budget: ${used} of ${budget} tokens used since this start${stop}.`;
}

function usageLabel(usage: NonNullable<AgentSession["usage"]>): string {
  const credits = usage.aiCredits === null ? "" : `, ${usage.aiCreditsPartial ? "at least " : ""}${usage.aiCredits} AI credits`;
  return `${countLabel(usage.modelCalls, MODEL_CALLS)}, ${usage.inputTokens} input and ${usage.outputTokens} output tokens${credits}`;
}

function taskLines(task: Task, withPrompt: boolean): string[] {
  const from = task.baseBranch === null ? "" : ` from ${task.baseBranch}`;
  const options = [
    `proposed by ${proposerLabel(task.proposedBy)}`,
    `model ${task.model ?? "default"}`,
    `approvals ${task.approvals}`,
    task.sandbox ? "sandbox" : undefined,
    task.javaNavigation ? "Java navigation" : undefined,
    task.item === null ? undefined : `board item ${task.item}`,
    task.change === null ? undefined : `part ${task.change.position + 1} of change ${task.change.id}`,
  ].filter((option) => option !== undefined);
  const lines = [
    `## Task ${task.id}${task.title === null ? "" : `: ${task.title}`}`,
    `Branch ${task.branch}${from} at ${task.base.slice(0, 12)}, created ${task.createdAt}; worktree ${task.worktree}; port ${task.port}`,
    options.join("; "),
  ];
  if (task.included.files.length > 0) lines.push(`Included files: ${task.included.files.join(", ")}`);
  if (task.included.problems.length > 0) lines.push(`Included files problems: ${task.included.problems.join("; ")}`);
  lines.push(withPrompt ? `Prompt:\n${task.prompt}` : `Prompt left out (${GET_SESSION_PROMPT_ARG}: true adds it).`);
  lines.push(...summaryLines(task.summary));
  return lines;
}

/** Who proposed the task, so an agent knows whether it wrote the prompt itself (ADR-39, ADR-147, ADR-155). */
function proposerLabel(proposedBy: Task["proposedBy"]): string {
  if (proposedBy === null) return "the user";
  if (proposedBy.supervisor) return proposedBy.session === null ? "the user, handed to the supervisor" : "the supervisor";
  if (proposedBy.session !== null) return `session ${proposedBy.session}`;
  return proposedBy.task === null ? "an agent outside Trackwall" : `the user, from the impact of task ${proposedBy.task}`;
}

function summaryLines(summary: Task["summary"]): string[] {
  if (summary === null) return ["## Summary: not reported yet"];
  const steps = summary.checkSteps.map((step, i) => `${i + 1}. ${step}`);
  const repro = summary.reproTest;
  return [
    `## Summary (reported ${summary.reportedAt})`,
    summary.text,
    ...(steps.length > 0 ? ["Check steps:", ...steps] : []),
    ...(repro === null ? [] : [reproTestLine(repro)]),
  ];
}

function changesLines(changes: TaskChangesSummary | null, error: string | null): string[] {
  if (changes === null) return [`## Changes unknown: ${error ?? "not computed"}`];
  const counts = `${countLabel(changes.commits, COMMITS)}, ${changes.uncommitted} uncommitted, ${countLabel(changes.files.length, FILES)}`;
  const more = changes.filesTruncated ? ["More files changed than listed."] : [];
  return [`## Changes: ${counts}`, ...changes.files.map(fileLine), ...more];
}

/** `M path +10 -2`; a binary file has no line counts. */
function fileLine(file: ChangedFile): string {
  const counts = [
    file.additions === null ? undefined : `+${file.additions}`,
    file.deletions === null ? undefined : `-${file.deletions}`,
  ].filter((count) => count !== undefined);
  return [CHANGE_LETTER[file.change], file.path, ...counts].join(" ");
}

function verificationLines(verification: Verification): string[] {
  const end = verification.finishedAt === null ? `started ${verification.startedAt}` : `finished ${verification.finishedAt}`;
  const exit = verification.exitCode === null ? "" : `, exit code ${verification.exitCode}`;
  // An outdated verdict (ADR-209) is for files the worktree no longer holds.
  const state = verification.outdated ? `${verification.state}, but outdated: the worktree changed since` : verification.state;
  const lines = [`## Verification: ${state} (mise task ${verification.miseTask}, ${end}${exit})`];
  if (verification.message !== null) lines.push(`Message: ${verification.message}`);
  if (verification.tests !== null) lines.push(testsLine(verification.tests));
  lines.push(...verification.failures.flatMap(failureLines), ...verification.errors.flatMap(errorLines));
  if (verification.lastLines.length > 0) lines.push("Last lines:", ...indented(verification.lastLines));
  return lines;
}

function testsLine(tests: NonNullable<Verification["tests"]>): string {
  const { totals } = tests;
  const facts = [
    `${countLabel(totals.tests, TESTS)}, ${countLabel(totals.failures, FAILURES)}, ${countLabel(totals.errors, ERRORS)}, ${totals.skipped} skipped`,
    countLabel(tests.reports, REPORTS),
    tests.unreadReports > 0 ? `${tests.unreadReports} unreadable` : undefined,
    tests.earlierReports > 0 ? `${tests.earlierReports} from earlier runs` : undefined,
    tests.truncated ? "search cut at its limit" : undefined,
  ].filter((fact) => fact !== undefined);
  return `Tests: ${facts.join("; ")}`;
}

function failureLines(failure: TestFailure): string[] {
  const where = failure.className === null ? failure.suite : `${failure.suite} ${failure.className}`;
  const type = failure.type === null ? "" : ` ${failure.type}`;
  const message = failure.message === null ? "" : `: ${failure.message}`;
  return [`Failed test ${where} ${failure.name} (${failure.kind}${type})${message}`, ...cutLines(failure.lines, failure.omittedLines)];
}

function errorLines(error: LogError): string[] {
  const times = error.count > 1 ? ` (${error.count} times)` : "";
  const exception = error.exception === null ? "" : `: ${error.exception}`;
  return [`Log ${error.level} in ${error.stream}${times}${exception}`, ...cutLines(error.lines, error.omittedLines)];
}

function cutLines(lines: string[], omitted: number): string[] {
  return [...indented(lines), ...(omitted > 0 ? [`  (${countLabel(omitted, MORE_LINES)})`] : [])];
}

function indented(lines: string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

function javaNavigationLabel(status: JavaNavigationStatus): string {
  switch (status.kind) {
    case "importing":
    case "stalled":
      return `${status.kind} since ${status.since}`;
    case "failed":
      return `failed: ${status.message}`;
    default:
      return status.kind;
  }
}
