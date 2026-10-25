import { realpath } from "node:fs/promises";
import {
  BATCH_STEPS,
  type BatchRepo,
  type BatchRequest,
  type BatchRun,
  type BatchStep,
  type BatchStepState,
  type RunState,
  type SyncResult,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { runOutcome, syncOutcome } from "./step-outcome.ts";

/**
 * The `batch` module (§4.8, ADR-27): the batch command, i.e. chosen steps (sync, `mise install`, the mise tasks
 * `setup` and `build`) on chosen repos, several repos at once, and step by step within a repo. It composes the `workspace` and `mise`
 * modules from above and runs nothing itself: `mise` starts processes through `procs`, so the mise tasks are visible and can be
 * stopped in the repo details too. A rerun is cheap thanks to mise's cache (the mise task's `sources` and `outputs`), not our own.
 * Kept only in memory, like sync; one runs at a time.
 */

/**
 * How many directories at once: a Java or frontend build takes several cores and GBs of memory, and `mise install` downloads a JDK
 * and Node; more repos in parallel on a laptop only make each of them take longer.
 */
const BATCH_CONCURRENCY = 3;

/**
 * A step that is a mise task, and the name of that mise task (the convention from `CONTEXT.md`, "mise task"). Separate from the step name,
 * because the step is an API contract, and the mise task name a repo convention, which may get a setting in `workspace.yaml`.
 */
const MISE_TASK = { setup: "setup", build: "build" } as const satisfies Partial<Record<BatchStep, string>>;

/** What `batch` needs from `workspace`; wired in the facade (§4). */
interface BatchWorkspace {
  repoPath(id: string): Promise<string>;
  syncRepo(id: string): Promise<SyncResult>;
}

/** What `batch` needs from `mise`: a run awaited to the end, interrupted by a signal. */
interface BatchMise {
  installTools(repo: string, signal: AbortSignal): Promise<RunState>;
  runToEnd(repo: string, miseTask: string, signal: AbortSignal): Promise<RunState | null>;
}

export interface BatchDeps {
  workspace: BatchWorkspace;
  mise: BatchMise;
  log: (msg: string) => void;
}

interface Active {
  run: BatchRun;
  abort: AbortController;
}

export class Batch {
  private readonly deps: BatchDeps;
  private last: Active | undefined;
  /** A start in progress (repos are still being checked): a second start meanwhile would begin a second command. */
  private starting = false;
  /** The daemon is stopping: a command started now would run processes after `stopAll`. */
  private closed = false;

  constructor(deps: BatchDeps) {
    this.deps = deps;
  }

  /** Starts the command in the background and returns it right away; an unknown repo rejects the whole request before anything starts. */
  async start(request: BatchRequest): Promise<BatchRun> {
    if (this.starting || this.last?.run.finishedAt === null)
      throw new DomainError("bad_request", "a batch command is running; wait for it to finish or cancel it");
    this.starting = true;
    try {
      const targets = await Promise.all(request.repos.map(async (repo) => ({ repo, path: await this.deps.workspace.repoPath(repo) })));
      const steps = BATCH_STEPS.filter((step) => request.steps.includes(step));
      const run: BatchRun = {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        cancelled: false,
        repos: targets.map((target) => ({ ...target, steps: steps.map((step) => ({ step, state: "waiting" })) })),
      };
      const groups = await groupBySameDir(run.repos);
      if (this.closed) throw new DomainError("bad_request", "the daemon is stopping");
      const abort = new AbortController();
      this.last = { run, abort };
      void mapLimit(groups, BATCH_CONCURRENCY, async (repos) => {
        for (const repo of repos) await this.runRepo(repo, abort.signal);
      })
        .catch((err: unknown) => this.deps.log(`batch command: ${messageOf(err)}`))
        .finally(() => {
          run.finishedAt = new Date().toISOString();
        });
      return snapshot(run);
    } finally {
      this.starting = false;
    }
  }

  /** The last command since the daemon started. */
  run(): BatchRun | null {
    return this.last ? snapshot(this.last.run) : null;
  }

  /**
   * Cancels the running command: steps that have not started end as `cancelled`, and the group stop halts running `mise`
   * processes. A running repo sync finishes on its own, because git is not in a process group.
   */
  cancel(): BatchRun | null {
    if (this.last?.run.finishedAt === null) {
      this.last.run.cancelled = true;
      this.last.abort.abort();
    }
    return this.run();
  }

  /** Daemon exit: cancels the running command and does not allow a new one to start, including one that is just starting. */
  close(): void {
    this.closed = true;
    this.cancel();
  }

  /** A repo's steps one after another; an error or cancellation of a step ends the repo, and a skip (e.g. no mise task) does not. */
  private async runRepo(repo: BatchRepo, signal: AbortSignal): Promise<void> {
    let stopped: BatchStepState | undefined;
    for (const [i, { step }] of repo.steps.entries()) {
      if (signal.aborted) stopped = { state: "cancelled" };
      if (stopped) {
        repo.steps[i] = { step, ...stopped };
        continue;
      }
      repo.steps[i] = { step, state: "running" };
      const outcome = await this.runStep(repo, step, signal);
      repo.steps[i] = { step, ...outcome };
      if (outcome.state === "failed") stopped = { state: "skipped", message: `skipped after step ${step} failed` };
      if (outcome.state === "cancelled") stopped = outcome;
    }
  }

  private async runStep({ repo, path }: BatchRepo, step: BatchStep, signal: AbortSignal): Promise<BatchStepState> {
    try {
      // An identifier from a directory name can move to another directory during the command (ADR-18); a step runs only
      // in the repo the user sees in the results.
      if ((await this.deps.workspace.repoPath(repo)) !== path)
        return { state: "failed", message: `${repo} now points to a different directory than ${path}`, lastLines: [] };
      switch (step) {
        case "sync":
          return syncOutcome(await this.deps.workspace.syncRepo(repo));
        case "tools":
          return runOutcome(await this.deps.mise.installTools(repo, signal));
        case "setup":
        case "build": {
          const run = await this.deps.mise.runToEnd(repo, MISE_TASK[step], signal);
          return run ? runOutcome(run) : { state: "skipped", message: `the repo has no mise task ${MISE_TASK[step]}` };
        }
      }
    } catch (err) {
      // Only a cancellation before the process starts; a stop error after cancellation (`stop_unconfirmed`) is a step error.
      if (err === signal.reason) return { state: "cancelled" };
      return { state: "failed", message: messageOf(err), lastLines: [] };
    }
  }
}

/**
 * Repos grouped by directory on disk: a link in the projects folder to another repo on the list is a
 * separate entry, and two `pnpm install` runs or builds at once in one directory break each other's files. Entries of one
 * group go one after another, groups in parallel. Case-insensitive, like Windows and macOS drives (on Linux `Web` and `web`
 * then go one after another, which costs only time). A directory that `realpath` cannot read stays under its own path:
 * its step will end in an error anyway.
 */
async function groupBySameDir(repos: readonly BatchRepo[]): Promise<BatchRepo[][]> {
  const keyed = await Promise.all(
    repos.map(async (repo) => ({ repo, key: (await realpath(repo.path).catch(() => repo.path)).toLowerCase() })),
  );
  const groups = new Map<string, BatchRepo[]>();
  for (const { repo, key } of keyed) groups.set(key, [...(groups.get(key) ?? []), repo]);
  return [...groups.values()];
}

/** A copy for the caller: the command changes in the background, and the result should show one moment. */
function snapshot(run: BatchRun): BatchRun {
  return { ...run, repos: run.repos.map((repo) => ({ ...repo, steps: [...repo.steps] })) };
}
