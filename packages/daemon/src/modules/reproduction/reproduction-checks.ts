import {
  ReproductionCheck,
  type ReproductionRun,
  type ReproTest,
  type RunState,
  sameReproTest,
  type TestCase,
  VERIFY_MISE_TASK,
} from "@trackwall/protocol";
import { z } from "zod";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { FollowedStateFile, stateFormat } from "../../infra/state-file.ts";
import { copyChanged, gitPath, testSide } from "./repro-copy.ts";
import { type ReproTarget, reproOutcome, reproTarget } from "./repro-test-case.ts";
import { needsChangeRun, reproductionVerdict } from "./reproduction-verdict.ts";

/**
 * The `reproduction` module (§4, §4.27, ADR-227): the reproduction check of a task, Trackwall's own answer to whether the
 * test the task's agent names (`reproTest`, ADR-222) fails without the fix and passes with it. It makes its own copy of
 * the repo beside the task's worktree, a worktree of the base commit without a branch, with the files `.worktreeinclude`
 * names and the task's test side; runs the mise task `test` there (filtered to the test's class when the mise task takes
 * a filter); copies the rest of the task's changes in and runs it again; and reads the test's cases from the JUnit reports
 * each run wrote. The task's own worktree is only read, so the agent and its runs are never disturbed; a worktree that
 * changes during the check makes it inconclusive, and one that changes after it makes its verdict outdated (ADR-276).
 * The copy is removed before the check ends. It composes `agents`, `vcs`, `workspace`, `mise` and `test-results` and keeps the last check of each task, also across a daemon restart, in
 * `reproduction-checks.json`.
 */

export const REPRODUCTION_CHECKS_FILE = "reproduction-checks.json";

/**
 * A check with the fingerprint of the worktree it started on (ADR-276), `null` before its copy was made or when it
 * could not be read; a file from before fingerprints has none, read as never outdated.
 */
const StoredCheck = ReproductionCheck.extend({ worktreeFingerprint: z.string().nullable().default(null) });
const StoredChecks = z.object({ checks: z.array(StoredCheck) });
/** `reproduction-checks.json` (ADR-223). */
export const REPRODUCTION_CHECKS_FORMAT = stateFormat(StoredChecks);
type StoredChecks = z.infer<typeof StoredChecks>;

/** Why a check the previous daemon left running has no verdict. */
const STOPPED_WITH_DAEMON = "Trackwall stopped during the check, so it has no verdict; check again";

/** What a check of a task works with, from `agents`. */
interface ReproSubject {
  repo: string;
  worktree: string;
  base: string;
  reproTest: ReproTest | null;
  miseConfigPaths: string[];
  copy: string;
}

interface ReproductionTasks {
  findTask(id: string): { repo: string } | undefined;
  reproSubject(id: string): ReproSubject;
  reproCopyOf(id: string): { repo: string; copy: string };
}

interface ReproductionVcs {
  addCheckout(repoDir: string, path: string, commit: string): Promise<void>;
  removeWorktree(repoDir: string, path: string): Promise<void>;
  changedPaths(dir: string, base: string): Promise<{ paths: string[]; truncated: boolean }>;
  worktreeFingerprint(dir: string, base: string): Promise<string>;
  copyIncludedFiles(repoDir: string, worktree: string): Promise<unknown>;
}

interface ReproductionRepos {
  repoPath(id: string): Promise<string>;
}

interface ReproductionMise {
  runInReproCopy(
    target: { repo: string; task: string },
    miseTask: string,
    filter: string,
    signal: AbortSignal,
  ): Promise<{ run: RunState; filtered: boolean }>;
}

interface ReproductionReports {
  casesIn(dir: string, since: string): Promise<{ cases: TestCase[]; unread: number; truncated: boolean }>;
}

export interface ReproductionChecksDeps {
  tasks: ReproductionTasks;
  vcs: ReproductionVcs;
  repos: ReproductionRepos;
  mise: ReproductionMise;
  reports: ReproductionReports;
  /** `reproduction-checks.json` in the state directory. */
  file: string;
  log: (msg: string) => void;
}

interface Entry {
  /** Replaced, never changed in place. */
  check: ReproductionCheck;
  /** The fingerprint of the task's worktree the check copied from; `null` before it was read. */
  fingerprint: string | null;
  abort: AbortController;
  /** Settles, never rejects, once the check has ended and its copy was removed (or its removal failed and was logged). */
  done: Promise<void>;
}

/** A check that runs: where it is and what it looks for. */
interface Running {
  task: string;
  subject: ReproSubject;
  target: ReproTarget;
  repoDir: string;
  signal: AbortSignal;
}

type Outcome = Pick<ReproductionCheck, "state" | "message">;

export class ReproductionChecks {
  readonly #deps: ReproductionChecksDeps;
  readonly #byTask = new Map<string, Entry>();
  readonly #file: FollowedStateFile<StoredChecks>;

  constructor(deps: ReproductionChecksDeps) {
    this.#deps = deps;
    this.#file = new FollowedStateFile(deps.file, REPRODUCTION_CHECKS_FORMAT, {
      broken: (problem, aside) => deps.log(`${deps.file}: ${problem}; file moved to ${aside}, the tasks start without reproduction checks`),
      log: deps.log,
    });
    this.#restore();
  }

  /**
   * The checks the previous daemon left, of the tasks still there; one left running ended with that daemon, and the copy
   * it left goes now.
   */
  #restore(): void {
    for (const { worktreeFingerprint, ...check } of this.#file.read()?.checks ?? []) {
      if (!this.#deps.tasks.findTask(check.task)) continue;
      const left = check.state === "running";
      // A check a crash left running, or one a stop cancelled before its copy was removed.
      const copyLeft = left || check.message === STOPPED_WITH_DAEMON;
      const done = copyLeft ? this.#removeCopy(check.task).catch(() => {}) : Promise.resolve();
      const kept = left ? stopped(check, null) : check;
      this.#byTask.set(check.task, { check: kept, fingerprint: worktreeFingerprint, abort: new AbortController(), done });
    }
  }

  /**
   * Daemon exit, before the groups are stopped: a running check is kept as cancelled, since the stop ends its run, and is
   * told to stop, so it starts nothing more.
   */
  keepForRestart(): void {
    const now = new Date().toISOString();
    this.#file.follow({
      checks: [...this.#byTask.values()].map(({ check, fingerprint }) => ({
        ...(check.state === "running" ? stopped(check, now) : check),
        worktreeFingerprint: fingerprint,
      })),
    });
    this.#file.stopFollowing();
    for (const entry of this.#byTask.values()) entry.abort.abort();
  }

  /** The task's last check; `null` when there was none or the task has ended. */
  get(task: string): ReproductionCheck | null {
    if (!this.#deps.tasks.findTask(task)) return null;
    return this.#byTask.get(task)?.check ?? null;
  }

  /**
   * The task's last check of `test` and whether its verdict is outdated (ADR-276): a `reproduced` or `not_reproduced`
   * whose worktree now holds other files than the ones it copied. A check of a test the agent named before says nothing
   * about this one, so it is `null` then, as without a check. A worktree that cannot be read leaves the verdict as it is
   * (logged), as with a verification (ADR-209).
   */
  async withFreshness(task: string, test: ReproTest): Promise<{ check: ReproductionCheck | null; outdated: boolean }> {
    const entry = this.#byTask.get(task);
    const check = this.get(task);
    if (!entry || !check || !sameReproTest(check.test, test)) return { check: null, outdated: false };
    const verdict = check.state === "reproduced" || check.state === "not_reproduced";
    if (!verdict || entry.fingerprint === null) return { check, outdated: false };
    try {
      const { worktree, base } = this.#deps.tasks.reproSubject(task);
      return { check, outdated: (await this.#deps.vcs.worktreeFingerprint(worktree, base)) !== entry.fingerprint };
    } catch (err) {
      this.#deps.log(`reproduction check of task ${task}: fingerprint of its worktree: ${messageOf(err)}`);
      return { check, outdated: false };
    }
  }

  /**
   * Starts the task's check in the background, or returns the one running, also when it is of a test the agent named
   * before. `bad_request` when the task's agent named no reproduction test; a test Trackwall cannot look for ends the
   * check at once as `inconclusive`.
   */
  start(task: string): ReproductionCheck {
    const previous = this.#byTask.get(task);
    if (previous?.check.state === "running") return previous.check;
    const subject = this.#deps.tasks.reproSubject(task);
    if (subject.reproTest === null) throw new DomainError("bad_request", "the task's agent named no reproduction test to check");
    const entry: Entry = {
      check: startedCheck(task, subject.repo, subject.reproTest),
      fingerprint: null,
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.#byTask.set(task, entry);
    const target = reproTarget(subject.reproTest);
    if ("problem" in target) this.#end(entry, { state: "inconclusive", message: target.problem });
    else {
      // The removal of a copy the previous daemon left may still be under way.
      const before = previous?.done ?? Promise.resolve();
      entry.done = before.then(() => this.#run(entry, { task, subject, target, signal: entry.abort.signal }));
    }
    this.#follow();
    return entry.check;
  }

  /** Stops the task's running check; it ends `cancelled` once its copy is removed. */
  async cancel(task: string): Promise<ReproductionCheck | null> {
    const entry = this.#byTask.get(task);
    if (!entry) return this.get(task);
    entry.abort.abort();
    await entry.done;
    return this.get(task);
  }

  /**
   * The task is being ended: its check stops and its copy goes (also one a crashed daemon left), awaited before the task's
   * worktree is removed, so no read of the worktree and no run on the task port outlives the task. A copy that cannot be
   * removed is logged and left, so the task still ends. The check is kept, since the end may still be refused.
   */
  async stop(task: string): Promise<void> {
    const entry = this.#byTask.get(task);
    if (entry) {
      entry.abort.abort();
      await entry.done;
    }
    await this.#removeCopy(task).catch(() => {});
  }

  /** The task has ended: nothing of its check is kept. */
  forget(task: string): void {
    this.#byTask.delete(task);
    this.#follow();
  }

  async #run(entry: Entry, start: Omit<Running, "repoDir">): Promise<void> {
    let outcome: Outcome;
    try {
      start.signal.throwIfAborted();
      const repoDir = await this.#deps.repos.repoPath(start.subject.repo);
      await this.#deps.vcs.removeWorktree(repoDir, start.subject.copy);
      outcome = await this.#check(entry, { ...start, repoDir });
    } catch (err) {
      if (start.signal.aborted) outcome = { state: "cancelled", message: "the check was stopped" };
      else {
        this.#deps.log(`reproduction check of task ${start.task}: ${messageOf(err)}`);
        outcome = { state: "inconclusive", message: messageOf(err) };
      }
    }
    const left = await this.#removeCopy(start.task).then(
      () => null,
      (err: unknown) => `its copy ${start.subject.copy} could not be removed (${messageOf(err)}); remove it by hand`,
    );
    this.#end(entry, left === null ? outcome : { ...outcome, message: [outcome.message, left].filter((m) => m !== null).join("; ") });
  }

  /** Removes the task's copy, from its repo and its folder; nothing when there is none. A failure is logged and thrown. */
  async #removeCopy(task: string): Promise<void> {
    try {
      const { repo, copy } = this.#deps.tasks.reproCopyOf(task);
      await this.#deps.vcs.removeWorktree(await this.#deps.repos.repoPath(repo), copy);
    } catch (err) {
      this.#deps.log(`reproduction check of task ${task}: removing its copy: ${messageOf(err)}`);
      throw err;
    }
  }

  /** The two runs and their verdict; the copy is made here and removed by the caller. */
  async #check(entry: Entry, running: Running): Promise<Outcome> {
    const { subject, signal } = running;
    const fingerprint = await this.#deps.vcs.worktreeFingerprint(subject.worktree, subject.base);
    entry.fingerprint = fingerprint;
    const changed = await this.#deps.vcs.changedPaths(subject.worktree, subject.base);
    if (changed.truncated) return { state: "inconclusive", message: "the task changes too many files for Trackwall to copy" };
    const { tests, rest } = testSide(changed.paths, entry.check.test.file, subject.miseConfigPaths);
    if (!tests.includes(gitPath(entry.check.test.file)))
      return { state: "inconclusive", message: `${entry.check.test.file} is not among the files the task changed` };
    signal.throwIfAborted();
    await this.#deps.vcs.addCheckout(running.repoDir, subject.copy, subject.base);
    await this.#deps.vcs.copyIncludedFiles(running.repoDir, subject.copy);
    await copyChanged(subject.worktree, subject.copy, tests);
    const base = await this.#runOnce(entry, running, "base");
    if (base.problem !== null) return { state: "inconclusive", message: base.problem };
    if (!needsChangeRun(base.run)) return reproductionVerdict(base.run, null);
    signal.throwIfAborted();
    // The rest comes from the worktree as it is now, which must be what the test side was copied from.
    if ((await this.#deps.vcs.worktreeFingerprint(subject.worktree, subject.base)) !== fingerprint)
      return { state: "inconclusive", message: "the task's files changed during the check; check again once the agent is done" };
    await copyChanged(subject.worktree, subject.copy, rest);
    const change = await this.#runOnce(entry, running, "change");
    if (change.problem !== null) return { state: "inconclusive", message: change.problem };
    return reproductionVerdict(base.run, change.run);
  }

  /**
   * One run of `test` in the copy, and what its reports say about the test; `problem` when the test is not in them and a
   * report could not be read or the search was cut, so its absence says nothing.
   */
  async #runOnce(
    entry: Entry,
    { task, subject, target, signal }: Running,
    phase: "base" | "change",
  ): Promise<{ run: ReproductionRun; problem: string | null }> {
    this.#update(entry, { phase });
    const { run, filtered } = await this.#deps.mise.runInReproCopy(
      { repo: subject.repo, task },
      VERIFY_MISE_TASK,
      target.className,
      signal,
    );
    signal.throwIfAborted();
    if (run.kind !== "exited") throw new Error(`the end of the run ${PHASE_WORDS[phase]} was not seen`);
    const read = await this.#deps.reports.casesIn(subject.copy, run.startedAt);
    const result: ReproductionRun = { runId: run.runId, exitCode: run.exitCode, ...reproOutcome(read.cases, target) };
    const filter = filtered ? target.className : null;
    this.#update(entry, phase === "base" ? { filter, base: result } : { filter, change: result });
    const unreadable = result.outcome === "missing" && (read.unread > 0 || read.truncated);
    return { run: result, problem: unreadable ? `the test reports of the run ${PHASE_WORDS[phase]} could not all be read` : null };
  }

  #update(entry: Entry, change: Partial<ReproductionCheck>): void {
    entry.check = { ...entry.check, ...change };
    this.#follow();
  }

  #end(entry: Entry, { state, message }: Outcome): void {
    this.#update(entry, { state, message, phase: null, finishedAt: new Date().toISOString() });
  }

  #follow(): void {
    this.#file.follow({
      checks: [...this.#byTask.values()].map(({ check, fingerprint }) => ({ ...check, worktreeFingerprint: fingerprint })),
    });
  }
}

const PHASE_WORDS = { base: "on the base", change: "with the change" } as const;

function startedCheck(task: string, repo: string, test: ReproTest): ReproductionCheck {
  return {
    task,
    repo,
    test,
    filter: null,
    state: "running",
    phase: "copy",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    base: null,
    change: null,
    message: null,
  };
}

function stopped(check: ReproductionCheck, finishedAt: string | null): ReproductionCheck {
  return { ...check, state: "cancelled", phase: null, finishedAt, message: STOPPED_WITH_DAEMON };
}
