import {
  countLabel,
  type ExitedRun,
  LOG_BUFFER_RECORDS,
  type LogErrors,
  type LogErrorsQuery,
  type MiseTarget,
  type RunState,
  type TestResults,
  VERIFICATION_MAX_ERRORS,
  VERIFICATION_MAX_FAILURES,
  VERIFY_MISE_TASK,
  Verification,
} from "@trackwall/protocol";
import { z } from "zod";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { FollowedStateFile } from "../../infra/state-file.ts";
import { waitLimited } from "../../infra/wait-limit.ts";

/**
 * The `verification` module (§4, §4.10, ADR-64): the verification of a task, one answer to "do the task's changes
 * pass?". It runs the mise task `test` in the task's worktree through `mise` (so the run is the same process group and
 * log the task panel and `run_mise_task` show) and, once the group has ended, sums up the exit code, the JUnit reports
 * written since the run started (`test-results`) and the errors of the run's log (`logs`) into a verdict. It composes
 * those modules and runs nothing itself, like `batch`. It keeps the last verification of every task, also across a
 * daemon restart (ADR-115) in `verifications.json`, which follows every change while the daemon works and stops
 * following once it stops (`keepForRestart`), so the runs the stop ends do not reach it as failures.
 */

export const VERIFICATIONS_FILE = "verifications.json";

/** What `verifications.json` keeps: the last verification of each task. */
const StoredVerifications = z.object({ verifications: z.array(Verification) });
type StoredVerifications = z.infer<typeof StoredVerifications>;

/** Why a verification the previous daemon left running has no verdict: its run ended with that daemon. */
const STOPPED_WITH_DAEMON = "Trackwall stopped during the run, so it has no verdict; verify again";

/** What the module needs from `agents`: a task's repo, and whether the task still exists. */
interface VerificationTasks {
  task(id: string): { repo: string };
  findTask(id: string): { repo: string } | undefined;
}

/** What the module needs from `mise`: a run in a task's worktree, its end, and a stop. */
interface VerificationMise {
  start(target: MiseTarget, miseTask: string): Promise<RunState>;
  ended(target: MiseTarget, miseTask: string): Promise<RunState | undefined>;
  stop(target: MiseTarget, miseTask: string): Promise<RunState>;
  run(target: MiseTarget, miseTask: string): RunState | undefined;
}

/** What the module needs from `test-results`: the reports written since a time. */
interface VerificationTestReports {
  results(target: MiseTarget, since: string | undefined): Promise<TestResults>;
}

/** What the module needs from `logs`: the errors of the run's log. */
interface VerificationLogs {
  errors(query: LogErrorsQuery): LogErrors;
}

export interface VerificationsDeps {
  tasks: VerificationTasks;
  mise: VerificationMise;
  testReports: VerificationTestReports;
  logs: VerificationLogs;
  /** A verification has its verdict (`passed`, `failed` or `cancelled`); the task's proposer hears about it (ADR-68). */
  onVerdict: (verification: Verification) => void;
  /** `verifications.json` in the state directory. */
  file: string;
  log: (msg: string) => void;
}

/** A task's worktree as a mise target: a verification never runs in a repo root. */
interface TaskTarget {
  repo: string;
  task: string;
}

interface Entry {
  /** Replaced, never changed in place, so a caller holds one moment of it. */
  verification: Verification;
  /** Settles once the verification is no longer `running`. */
  done: Promise<void>;
}

export class Verifications {
  readonly #deps: VerificationsDeps;
  readonly #byTask = new Map<string, Entry>();
  /** A start in progress per task: two clicks (or the button and the agent) at once give one verification. */
  readonly #starting = new Map<string, Promise<Verification>>();
  readonly #file: FollowedStateFile<StoredVerifications>;

  constructor(deps: VerificationsDeps) {
    this.#deps = deps;
    this.#file = new FollowedStateFile(deps.file, StoredVerifications, {
      broken: (problem, aside) => deps.log(`${deps.file}: ${problem}; file moved to ${aside}, the tasks start without verifications`),
      log: deps.log,
    });
    this.#restore();
  }

  /**
   * Daemon start: the verifications the previous daemon left, of the tasks still there; a missing or broken file leaves
   * none. One still `running` there is from a daemon that crashed: its run ended with it, at a time nobody saw.
   */
  #restore(): void {
    const stored = this.#file.read();
    if (stored === undefined) return;
    for (const verification of stored.verifications) {
      if (!this.#deps.tasks.findTask(verification.task)) continue;
      const restored = verification.state === "running" ? stoppedWithDaemon(verification, null) : verification;
      this.#byTask.set(verification.task, { verification: restored, done: Promise.resolve() });
    }
  }

  /**
   * Daemon exit, before `procs.stopAll`: the file keeps the verifications of this moment for the next daemon, a running
   * one as cancelled now, since the stop ends its run; the verdict that run then gives stays in this daemon.
   */
  keepForRestart(): void {
    const now = new Date().toISOString();
    this.#file.follow({
      verifications: [...this.#byTask.values()].map(({ verification: v }) => (v.state === "running" ? stoppedWithDaemon(v, now) : v)),
    });
    this.#file.stopFollowing();
  }

  /**
   * Starts the task's verification in the background, or returns the one running. The mise task starts before this
   * returns, so a missing `test` (`not_found`) or an untrusted mise config (`mise_unavailable`) is the caller's error,
   * not a verification. A `test` already running in the worktree (the agent's own run) is joined, not started again.
   */
  start(task: string): Promise<Verification> {
    const running = this.#byTask.get(task)?.verification;
    if (running?.state === "running") return Promise.resolve(running);
    const starting = this.#starting.get(task) ?? this.#start(task).finally(() => this.#starting.delete(task));
    this.#starting.set(task, starting);
    return starting;
  }

  /** The task's last verification; `null` when there was none or the task has ended. */
  get(task: string): Verification | null {
    if (!this.#deps.tasks.findTask(task)) return null;
    return this.#byTask.get(task)?.verification ?? null;
  }

  /**
   * Starts (or joins) the verification and waits until it has a verdict, at most `timeoutMs` counted from the call, so
   * a slow start does not push the call past the client's limit; `signal` (the client gave up) ends only the wait. For
   * an agent (`verify_task`): with the `runId` of a verification it got `running`, the call waits for that one and
   * returns it also when it has finished meanwhile, instead of starting a new run.
   */
  async verify(task: string, runId: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Verification> {
    const deadline = Date.now() + timeoutMs;
    const started = runId === undefined ? await this.start(task) : this.#awaited(task, runId);
    const entry = this.#byTask.get(task);
    if (started.state !== "running" || !entry) return started;
    await waitLimited(entry.done, Math.max(0, deadline - Date.now()), signal);
    return entry.verification;
  }

  /** The task's verification of run `runId`; `not_found` when a newer one replaced it or the task has ended. */
  #awaited(task: string, runId: string): Verification {
    const verification = this.get(task);
    if (verification?.runId !== runId)
      throw new DomainError("not_found", `task ${task} has no verification of run ${runId}; call without runId to verify again`);
    return verification;
  }

  /** Stops the running verification's mise task; it then ends `cancelled`. A finished one is returned as it is. */
  async cancel(task: string): Promise<Verification | null> {
    const entry = this.#byTask.get(task);
    if (entry?.verification.state !== "running") return this.get(task);
    const { repo, miseTask, runId } = entry.verification;
    // Once the run has ended the verdict is still being read; a run of `test` there now is the agent's, not ours.
    if (this.#deps.mise.run({ repo, task }, miseTask)?.runId === runId) await this.#deps.mise.stop({ repo, task }, miseTask);
    await entry.done;
    return entry.verification;
  }

  async #start(task: string): Promise<Verification> {
    this.#forgetEndedTasks();
    // On daemon exit `procs` refuses the run, so no verification starts after the groups were stopped.
    const target: TaskTarget = { repo: this.#deps.tasks.task(task).repo, task };
    const run = await this.#deps.mise.start(target, VERIFY_MISE_TASK);
    const entry: Entry = { verification: runningVerification(target, run), done: Promise.resolve() };
    entry.done = this.#finish(target, run).then(
      (verification) => this.#settle(entry, verification),
      (err: unknown) => {
        this.#deps.log(`verification of task ${task}: ${messageOf(err)}`);
        this.#settle(entry, { ...entry.verification, state: "failed", finishedAt: new Date().toISOString(), message: messageOf(err) });
      },
    );
    this.#byTask.set(task, entry);
    this.#follow();
    return entry.verification;
  }

  /** The verdict goes into the entry and to its listener; it stands whatever the listener does with it. */
  #settle(entry: Entry, verification: Verification): void {
    entry.verification = verification;
    this.#follow();
    try {
      this.#deps.onVerdict(verification);
    } catch (err) {
      this.#deps.log(`verification of task ${verification.task}: ${messageOf(err)}`);
    }
  }

  /**
   * Ended tasks keep no verification: their failures and log lines would stay in memory and in the file for nobody. The
   * file follows at once, also when the start that prunes them then fails.
   */
  #forgetEndedTasks(): void {
    for (const task of this.#byTask.keys()) if (!this.#deps.tasks.findTask(task)) this.#byTask.delete(task);
    this.#follow();
  }

  /** The verifications as they are now, for the next daemon. */
  #follow(): void {
    this.#file.follow({ verifications: [...this.#byTask.values()].map((entry) => entry.verification) });
  }

  /** The verdict once the run's group has ended: the exit code, then the reports the run wrote, then its log errors. */
  async #finish(target: TaskTarget, run: RunState): Promise<Verification> {
    const end = await this.#deps.mise.ended(target, VERIFY_MISE_TASK);
    if (end?.kind !== "exited" || end.runId !== run.runId)
      throw new Error(`the end of run ${run.runId} of mise task ${VERIFY_MISE_TASK} was not seen`);
    const ended = { ...runningVerification(target, run), finishedAt: end.endedAt, exitCode: end.exitCode };
    if (end.stoppedByUser) return { ...ended, state: "cancelled" };
    const read = await this.#deps.testReports.results(target, run.startedAt).then(
      (results) => ({ results, problem: null }),
      (err: unknown) => ({ results: null, problem: `test reports not read: ${messageOf(err)}` }),
    );
    const failedTests = read.results ? read.results.totals.failures + read.results.totals.errors : 0;
    const tests = read.results && {
      totals: read.results.totals,
      reports: read.results.reports.length,
      unreadReports: read.results.problems.length,
      earlierReports: read.results.earlierReports,
      truncated: read.results.truncated,
    };
    // A report the reader could not parse may hold a failed test, so it never counts as a pass.
    const failed = end.exitCode !== 0 || failedTests > 0 || (tests?.unreadReports ?? 0) > 0;
    const messages = [verdictMessage(end, failedTests, tests), read.problem].filter((m) => m !== null);
    return {
      ...ended,
      state: failed ? "failed" : "passed",
      message: messages.length > 0 ? messages.join("; ") : null,
      tests,
      failures: read.results?.failures.slice(0, VERIFICATION_MAX_FAILURES) ?? [],
      errors: failed ? this.#runErrors(target, run.runId) : [],
      lastLines: failed ? end.lastLines : [],
    };
  }

  /** The run's errors in the order they were logged: the first one is usually the cause (a compiler error, a failed test). */
  #runErrors({ repo, task }: TaskTarget, runId: string) {
    // Every error the buffer holds, not the newest 100: the first errors of a long run are the ones to show.
    const { errors } = this.#deps.logs.errors({ repo, task, miseTask: VERIFY_MISE_TASK, minLevel: "error", limit: LOG_BUFFER_RECORDS });
    return errors
      .filter((error) => error.runId === runId)
      .reverse()
      .slice(0, VERIFICATION_MAX_ERRORS);
  }
}

/** A verification whose run the daemon's stop ended, so it has no verdict; `finishedAt` when the stop was seen. */
function stoppedWithDaemon(verification: Verification, finishedAt: string | null): Verification {
  return { ...verification, state: "cancelled", finishedAt, message: STOPPED_WITH_DAEMON };
}

function runningVerification({ repo, task }: TaskTarget, run: RunState): Verification {
  return {
    task,
    repo,
    miseTask: VERIFY_MISE_TASK,
    state: "running",
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: null,
    exitCode: null,
    message: null,
    tests: null,
    failures: [],
    errors: [],
    lastLines: [],
  };
}

/** Why the run failed, or what to know about a pass without reports; `null` for a plain pass. */
function verdictMessage(end: ExitedRun, failedTests: number, tests: Verification["tests"]): string | null {
  if (end.exitCode === null) return `mise task ${VERIFY_MISE_TASK} was ended by signal ${end.signal}`;
  if (end.exitCode !== 0) return `mise task ${VERIFY_MISE_TASK} exited with code ${end.exitCode}`;
  const unread =
    tests && tests.unreadReports > 0
      ? `${countLabel(tests.unreadReports, { one: "test report", other: "test reports" })} could not be read, so failed tests may be missing`
      : null;
  if (failedTests > 0) {
    const failed = `${countLabel(failedTests, { one: "test", other: "tests" })} failed in the test reports, although mise task ${VERIFY_MISE_TASK} exited with code 0`;
    return unread ? `${failed}; ${unread}` : failed;
  }
  if (unread) return unread;
  if (tests && tests.reports === 0 && tests.earlierReports > 0)
    return `the run wrote no test reports; ${tests.earlierReports} from earlier runs were left out (tests up to date?)`;
  if (tests && tests.reports === 0) return "the run wrote no JUnit test reports";
  return null;
}
