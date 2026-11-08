import { ReproductionCheck, type ReproductionRun, type ReproTest, type RunState, VERIFY_MISE_TASK } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { FollowedStateFile } from "../../infra/state-file.ts";
import { copyChanged, testSide } from "./repro-copy.ts";
import { type ReproCase, type ReproTarget, reproOutcome, reproTarget } from "./repro-test-case.ts";
import { needsChangeRun, reproductionVerdict } from "./reproduction-verdict.ts";

/**
 * The `reproduction` module (§4, §4.27, ADR-227): the reproduction check of a task, Trackwall's own answer to whether the
 * test the task's agent names (`reproTest`, ADR-222) fails without the fix and passes with it. It makes its own copy of
 * the repo beside the task's worktree, a worktree of the base commit without a branch, with the files `.worktreeinclude`
 * names and the task's test files; runs the mise task `test` there (filtered to the test's class when the mise task takes
 * a filter); copies the rest of the task's changes in and runs it again; and reads the test's cases from the JUnit reports
 * each run wrote. The task's own worktree is only read, so the agent and its runs are never disturbed. The copy is removed
 * when the check ends. It composes `agents`, `vcs`, `workspace`, `mise` and `test-results` and keeps the last check of
 * each task, also across a daemon restart, in `reproduction-checks.json`.
 */

export const REPRODUCTION_CHECKS_FILE = "reproduction-checks.json";

const StoredChecks = z.object({ checks: z.array(ReproductionCheck) });
type StoredChecks = z.infer<typeof StoredChecks>;

/** Why a check the previous daemon left running has no verdict. */
const STOPPED_WITH_DAEMON = "Trackwall stopped during the check, so it has no verdict; check again";

/** What a check of a task works with, from `agents`. */
interface ReproSubject {
  repo: string;
  worktree: string;
  base: string;
  reproTest: ReproTest | null;
  copy: string;
}

interface ReproductionTasks {
  findTask(id: string): { repo: string } | undefined;
  reproSubject(id: string): ReproSubject;
}

interface ReproductionVcs {
  addCheckout(repoDir: string, path: string, commit: string): Promise<void>;
  removeWorktree(repoDir: string, path: string): Promise<void>;
  changedPaths(dir: string, base: string): Promise<{ paths: string[]; truncated: boolean }>;
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
  casesIn(dir: string, since: string): Promise<{ cases: ReproCase[] }>;
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
  abort: AbortController;
  /** Settles once the check has ended and its copy is gone. */
  done: Promise<void>;
}

/** A check that runs: where it is and what it found so far. */
interface Running {
  task: string;
  subject: ReproSubject;
  target: ReproTarget;
  repoDir: string;
  signal: AbortSignal;
}

export class ReproductionChecks {
  readonly #deps: ReproductionChecksDeps;
  readonly #byTask = new Map<string, Entry>();
  readonly #file: FollowedStateFile<StoredChecks>;

  constructor(deps: ReproductionChecksDeps) {
    this.#deps = deps;
    this.#file = new FollowedStateFile(deps.file, StoredChecks, {
      broken: (problem, aside) => deps.log(`${deps.file}: ${problem}; file moved to ${aside}, the tasks start without reproduction checks`),
      log: deps.log,
    });
    this.#restore();
  }

  /** The checks the previous daemon left, of the tasks still there; one left running ended with that daemon. */
  #restore(): void {
    for (const check of this.#file.read()?.checks ?? []) {
      if (!this.#deps.tasks.findTask(check.task)) continue;
      const restored = check.state === "running" ? stopped(check, null) : check;
      this.#byTask.set(check.task, { check: restored, abort: new AbortController(), done: Promise.resolve() });
    }
  }

  /** Daemon exit, before the groups are stopped: a running check is kept as cancelled, since the stop ends its run. */
  keepForRestart(): void {
    const now = new Date().toISOString();
    this.#file.follow({ checks: [...this.#byTask.values()].map(({ check }) => (check.state === "running" ? stopped(check, now) : check)) });
    this.#file.stopFollowing();
  }

  /** The task's last check; `null` when there was none or the task has ended. */
  get(task: string): ReproductionCheck | null {
    if (!this.#deps.tasks.findTask(task)) return null;
    return this.#byTask.get(task)?.check ?? null;
  }

  /**
   * Starts the task's check in the background, or returns the one running. `bad_request` when the task's agent named no
   * reproduction test; a test Trackwall cannot look for ends the check at once as `inconclusive`.
   */
  start(task: string): ReproductionCheck {
    const running = this.#byTask.get(task);
    if (running?.check.state === "running") return running.check;
    const subject = this.#deps.tasks.reproSubject(task);
    if (subject.reproTest === null) throw new DomainError("bad_request", "the task's agent named no reproduction test to check");
    const startedAt = new Date().toISOString();
    const check: ReproductionCheck = {
      task,
      repo: subject.repo,
      test: subject.reproTest,
      filter: null,
      state: "running",
      phase: "copy",
      startedAt,
      finishedAt: null,
      base: null,
      change: null,
      message: null,
    };
    const target = reproTarget(subject.reproTest);
    const entry: Entry = { check, abort: new AbortController(), done: Promise.resolve() };
    this.#byTask.set(task, entry);
    if ("problem" in target) this.#end(entry, { state: "inconclusive", message: target.problem });
    else entry.done = this.#run(entry, { task, subject, target, signal: entry.abort.signal });
    this.#follow();
    return entry.check;
  }

  /** Stops the task's running check; it ends `cancelled` once its copy is gone. */
  async cancel(task: string): Promise<ReproductionCheck | null> {
    const entry = this.#byTask.get(task);
    if (!entry) return this.get(task);
    entry.abort.abort();
    await entry.done;
    return this.get(task);
  }

  /** The task has ended: its check stops, its copy goes, and nothing of it is kept. */
  async forget(task: string): Promise<void> {
    const entry = this.#byTask.get(task);
    if (!entry) return;
    entry.abort.abort();
    await entry.done;
    this.#byTask.delete(task);
    this.#follow();
  }

  async #run(entry: Entry, start: Omit<Running, "repoDir">): Promise<void> {
    let repoDir: string | undefined;
    try {
      repoDir = await this.#deps.repos.repoPath(start.subject.repo);
      const running: Running = { ...start, repoDir };
      // A copy an interrupted check or daemon left behind.
      await this.#deps.vcs.removeWorktree(repoDir, start.subject.copy);
      this.#end(entry, await this.#check(entry, running));
    } catch (err) {
      if (start.signal.aborted) this.#end(entry, { state: "cancelled", message: "the check was stopped" });
      else {
        this.#deps.log(`reproduction check of task ${start.task}: ${messageOf(err)}`);
        this.#end(entry, { state: "inconclusive", message: messageOf(err) });
      }
    } finally {
      if (repoDir !== undefined)
        await this.#deps.vcs
          .removeWorktree(repoDir, start.subject.copy)
          .catch((err: unknown) => this.#deps.log(`reproduction check of task ${start.task}: removing its copy: ${messageOf(err)}`));
    }
  }

  /** The two runs and their verdict; the copy is made here and removed by the caller. */
  async #check(entry: Entry, running: Running): Promise<Pick<ReproductionCheck, "state" | "message">> {
    const { subject, signal } = running;
    const changed = await this.#deps.vcs.changedPaths(subject.worktree, subject.base);
    if (changed.truncated) return { state: "inconclusive", message: "the task changes too many files for Trackwall to copy" };
    const { tests, rest } = testSide(changed.paths, entry.check.test.file);
    if (!tests.includes(entry.check.test.file.replaceAll("\\", "/")))
      return { state: "inconclusive", message: `${entry.check.test.file} is not among the files the task changed` };
    signal.throwIfAborted();
    await this.#deps.vcs.addCheckout(running.repoDir, subject.copy, subject.base);
    await this.#deps.vcs.copyIncludedFiles(running.repoDir, subject.copy);
    await copyChanged(subject.worktree, subject.copy, tests);
    const base = await this.#runOnce(entry, running, "base");
    if (!needsChangeRun(base)) return reproductionVerdict(base, null);
    signal.throwIfAborted();
    await copyChanged(subject.worktree, subject.copy, rest);
    return reproductionVerdict(base, await this.#runOnce(entry, running, "change"));
  }

  /** One run of `test` in the copy, and what its reports say about the test. */
  async #runOnce(entry: Entry, { task, subject, target, signal }: Running, phase: "base" | "change"): Promise<ReproductionRun> {
    this.#update(entry, { phase });
    const { run, filtered } = await this.#deps.mise.runInReproCopy(
      { repo: subject.repo, task },
      VERIFY_MISE_TASK,
      target.className,
      signal,
    );
    signal.throwIfAborted();
    if (run.kind !== "exited") throw new Error(`the end of the run on the ${phase} was not seen`);
    const { cases } = await this.#deps.reports.casesIn(subject.copy, run.startedAt);
    const result: ReproductionRun = { runId: run.runId, exitCode: run.exitCode, ...reproOutcome(cases, target) };
    const filter = filtered ? target.className : null;
    this.#update(entry, phase === "base" ? { filter, base: result } : { filter, change: result });
    return result;
  }

  #update(entry: Entry, change: Partial<ReproductionCheck>): void {
    entry.check = { ...entry.check, ...change };
    this.#follow();
  }

  #end(entry: Entry, { state, message }: Pick<ReproductionCheck, "state" | "message">): void {
    this.#update(entry, { state, message, phase: null, finishedAt: new Date().toISOString() });
  }

  #follow(): void {
    this.#file.follow({ checks: [...this.#byTask.values()].map(({ check }) => check) });
  }
}

function stopped(check: ReproductionCheck, finishedAt: string | null): ReproductionCheck {
  return { ...check, state: "cancelled", phase: null, finishedAt, message: STOPPED_WITH_DAEMON };
}
