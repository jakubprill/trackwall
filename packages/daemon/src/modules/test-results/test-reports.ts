import { readFile } from "node:fs/promises";
import {
  type PromptDelivery,
  REPRODUCTION_FAILURE_MAX_CHARS,
  type TaskTestRef,
  type TaskTests,
  TEST_RESULTS_MAX_FAILURES,
  TEST_RESULTS_MAX_PROBLEMS,
  TEST_RESULTS_MAX_REPORTS,
  type TestCase,
  type TestFailure,
  type TestFix,
  type TestReport,
  type TestReportProblem,
  type TestResults,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { addCounts, emptyCounts, parseJunitReport } from "./junit-report.ts";
import { forAgent, type Mask, type ReadReport } from "./report-failure.ts";
import { findReportFiles, type ReportFile } from "./report-files.ts";
import { tabTestFix, taskTestsOf } from "./task-tests.ts";

/**
 * The `test-results` module (§4, §4.9, ADR-60): the JUnit XML reports a test run left in a repo root or a task's
 * worktree, read on request and summed up for an agent, so it learns which tests failed and why without scrolling a
 * Gradle or Maven log. It runs nothing and writes nothing; the reports are whatever the build tools wrote last, so
 * every report carries its modification time and `since` leaves out those from earlier runs. The tests of a task's
 * worktree also go to its "Tests" tab (ADR-304), and a failed one from there to the task's agent as a test fix. Every text from a
 * report is masked like a log line (§4.2) before it is cut, because a test can print a secret it read.
 */

/** What the module needs from `workspace`: the repo root by id (`not_found` for an unknown repo). */
interface TestReportsRepos {
  repoPath(id: string): Promise<string>;
}

/**
 * What the module needs from `agents`: a task's worktree (`not_found` for an unknown or ended task), whether a file the
 * task changed was written after a moment, and handing the user's test fix to the task's agent (ADR-304).
 */
interface TestReportsTasks {
  task(id: string): { worktree: string };
  taskChangedSince(id: string, sinceMs: number): Promise<boolean>;
  askToFixTests(id: string, fix: TestFix): PromptDelivery;
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

export class TestReports {
  readonly #deps: TestReportsDeps;

  constructor(deps: TestReportsDeps) {
    this.#deps = deps;
  }

  /** The reports under the target, newest first; only those written at or after `since` (ISO 8601) when it is given. */
  async results(target: TestReportsTarget, since: string | undefined): Promise<TestResults> {
    const dir = await this.#dir(target);
    const { found, read } = await this.#readNewestFirst(dir, since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since));
    const summary = summarize(read, await this.#mask());
    return { dir, ...summary, earlierReports: found.earlier, truncated: found.truncated || summary.truncated };
  }

  /**
   * Every test case of the reports under `dir` written at or after `since`, for a reproduction check (ADR-227), which
   * looks for one test in them; `dir` is the daemon's own copy of a repo, never a path from outside. Each failure's type and
   * message are masked and cut as for an agent; `unread` counts the reports that could not be read.
   */
  async casesIn(dir: string, since: string): Promise<{ cases: TestCase[]; unread: number; truncated: boolean }> {
    const found = await findReportFiles(dir, Date.parse(since));
    const read = await mapLimit(found.files, READ_CONCURRENCY, readReport);
    const mask = await this.#mask();
    const cut = (text: string | null) => (text === null ? null : mask(text).slice(0, REPRODUCTION_FAILURE_MAX_CHARS));
    const cases = read.flatMap((entry) =>
      "problem" in entry
        ? []
        : entry.report.cases.map(({ timeSeconds: _, ...c }) => ({ ...c, type: cut(c.type), message: cut(c.message) })),
    );
    return { cases, unread: read.filter((entry) => "problem" in entry).length, truncated: found.truncated };
  }

  /** Every test of the reports in a task's worktree, for its "Tests" tab (ADR-304). */
  async taskTests(task: string): Promise<TaskTests> {
    const { found, read } = await this.#readNewestFirst(this.#deps.tasks.task(task).worktree, Number.NEGATIVE_INFINITY);
    const tests = taskTestsOf(read, await this.#mask());
    const changedAfter = tests.newestReportAt !== null && (await this.#deps.tasks.taskChangedSince(task, Date.parse(tests.newestReportAt)));
    return { ...tests, changedAfter, truncated: found.truncated || tests.truncated };
  }

  /** Hands failed tests of a task's reports to its agent as a test fix (ADR-304): the one named, or the first ones. */
  async fixTests(task: string, test: TaskTestRef | null): Promise<{ delivery: PromptDelivery }> {
    const fix = tabTestFix(await this.taskTests(task), test);
    return { delivery: this.#deps.tasks.askToFixTests(task, fix) };
  }

  /** The reports under `dir` written at or after `sinceMs`, read, newest first; a missing `dir` is `not_found`. */
  async #readNewestFirst(dir: string, sinceMs: number) {
    const found = await findReportFiles(dir, sinceMs).catch((err: unknown) => {
      throw new DomainError("not_found", `cannot read ${dir}: ${messageOf(err)}`);
    });
    const files = found.files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    return { found, read: await mapLimit(files, READ_CONCURRENCY, readReport) };
  }

  /** Masking secret values of the user's environment like a log line (§4.2). */
  async #mask(): Promise<Mask> {
    const env = await this.#deps.env();
    return (text) => this.#deps.logs.mask(text, env);
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
