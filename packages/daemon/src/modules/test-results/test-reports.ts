import { readFile } from "node:fs/promises";
import {
  TEST_FAILURE_HEAD_LINES,
  TEST_FAILURE_LINE_MAX_CHARS,
  TEST_FAILURE_MESSAGE_MAX_CHARS,
  TEST_RESULTS_MAX_FAILURES,
  TEST_RESULTS_MAX_PROBLEMS,
  TEST_RESULTS_MAX_REPORTS,
  type TestFailure,
  type TestReport,
  type TestReportProblem,
  type TestResults,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { addCounts, emptyCounts, type JunitReport, parseJunitReport, type ReportFailure } from "./junit-report.ts";
import { findReportFiles, type ReportFile } from "./report-files.ts";

/**
 * The `test-results` module (§4, §4.9, ADR-60): the JUnit XML reports a test run left in a repo root or a task's
 * worktree, read on request and summed up for an agent, so it learns which tests failed and why without scrolling a
 * Gradle or Maven log. It runs nothing and writes nothing; the reports are whatever the build tools wrote last, so
 * every report carries its modification time and `since` leaves out those from earlier runs. Every text from a
 * report is masked like a log line (§4.2) before it is cut, because a test can print a secret it read.
 */

/** What the module needs from `workspace`: the repo root by id (`not_found` for an unknown repo). */
interface TestReportsRepos {
  repoPath(id: string): Promise<string>;
}

/** What the module needs from `agents`: a task's worktree (`not_found` for an unknown or ended task). */
interface TestReportsTasks {
  task(id: string): { worktree: string };
}

/** What the module needs from `logs`: masking secret values the way log lines are masked. */
interface TestReportsLogs {
  mask(text: string, env: NodeJS.ProcessEnv): string;
}

export interface TestReportsDeps {
  repos: TestReportsRepos;
  tasks: TestReportsTasks;
  logs: TestReportsLogs;
  /** Environment of the processes started for the user; its secret values are masked in the results. */
  env: () => Promise<NodeJS.ProcessEnv>;
}

/**
 * Where to read: the repo root (`task: null`) or the worktree of a task of that repo; the MCP tool checks that the task
 * belongs to the repo with the same check as `tail` and `get_errors`.
 */
export interface TestReportsTarget {
  repo: string;
  task: string | null;
}

/** A larger report is a log captured into `system-out`, not test results worth parsing in the daemon's thread. */
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const READ_CONCURRENCY = 8;
/** The line that starts a cause in a Java stack trace. */
const CAUSED_BY = /^\s*Caused by:/;

type ReadReport = { file: ReportFile; report: JunitReport } | { file: ReportFile; problem: string };
type Mask = (text: string) => string;

export class TestReports {
  readonly #deps: TestReportsDeps;

  constructor(deps: TestReportsDeps) {
    this.#deps = deps;
  }

  /** The reports under the target, newest first; only those written at or after `since` (ISO 8601) when it is given. */
  async results(target: TestReportsTarget, since: string | undefined): Promise<TestResults> {
    const dir = await this.#dir(target);
    const found = await findReportFiles(dir, since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since)).catch((err: unknown) => {
      throw new DomainError("not_found", `cannot read ${dir}: ${messageOf(err)}`);
    });
    const files = found.files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    const read = await mapLimit(files, READ_CONCURRENCY, readReport);
    const env = await this.#deps.env();
    const summary = summarize(read, (text) => this.#deps.logs.mask(text, env));
    return { dir, ...summary, earlierReports: found.earlier, truncated: found.truncated || summary.truncated };
  }

  async #dir({ repo, task }: TestReportsTarget): Promise<string> {
    return task === null ? this.#deps.repos.repoPath(repo) : this.#deps.tasks.task(task).worktree;
  }
}

async function readReport(file: ReportFile): Promise<ReadReport> {
  if (file.size > MAX_REPORT_BYTES) return { file, problem: `larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB, not read` };
  try {
    return { file, report: parseJunitReport(await readFile(file.file, "utf8")) };
  } catch (err) {
    return { file, problem: messageOf(err) };
  }
}

function summarize(read: readonly ReadReport[], mask: Mask) {
  const totals = emptyCounts();
  const reports: TestReport[] = [];
  const failures: TestFailure[] = [];
  const problems: TestReportProblem[] = [];
  for (const entry of read) {
    if ("problem" in entry) {
      problems.push({ path: entry.file.path, message: mask(entry.problem) });
      continue;
    }
    const { counts } = entry.report;
    addCounts(totals, counts);
    reports.push({ path: entry.file.path, modifiedAt: new Date(entry.file.mtimeMs).toISOString(), ...counts });
    for (const failure of entry.report.failures) failures.push(forAgent(failure, entry.file.path, mask));
  }
  return {
    totals,
    truncated:
      reports.length > TEST_RESULTS_MAX_REPORTS ||
      failures.length > TEST_RESULTS_MAX_FAILURES ||
      problems.length > TEST_RESULTS_MAX_PROBLEMS,
    reports: reports.slice(0, TEST_RESULTS_MAX_REPORTS),
    failures: failures.slice(0, TEST_RESULTS_MAX_FAILURES),
    problems: problems.slice(0, TEST_RESULTS_MAX_PROBLEMS),
  };
}

/** A failed test for an agent: every text masked first, then cut, so a cut never leaves half a secret unmasked. */
function forAgent({ stack, ...failure }: ReportFailure, report: string, mask: Mask): TestFailure {
  const masked = (text: string | null) => (text === null ? null : mask(text));
  return {
    ...failure,
    report,
    suite: mask(failure.suite),
    className: masked(failure.className),
    name: mask(failure.name),
    type: masked(failure.type),
    message: masked(failure.message)?.slice(0, TEST_FAILURE_MESSAGE_MAX_CHARS) ?? null,
    ...trimStack(mask(stack)),
  };
}

/**
 * The start of a stack trace and every `Caused by` with the frame after it, each line cut: the thrown exception and
 * its root cause are what an agent needs, the frames of the test framework in between are not.
 */
export function trimStack(text: string): { lines: string[]; omittedLines: number } {
  const all = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const kept = all.filter((line, i) => i < TEST_FAILURE_HEAD_LINES || CAUSED_BY.test(line) || CAUSED_BY.test(all[i - 1] ?? ""));
  return { lines: kept.map((line) => line.slice(0, TEST_FAILURE_LINE_MAX_CHARS)), omittedLines: all.length - kept.length };
}
