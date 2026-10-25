import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentTaskChanges,
  type ChangedFile,
  type IncludedFiles,
  NO_INCLUDED_FILES,
  PATCH_MAX_BYTES,
  type ProposedBy,
  type Session,
  TASK_SUMMARY_MAX_FILES,
  type Task,
  type TaskChanges,
  type TaskChangesSummary,
  type TaskMiseConfig,
  type TaskSharedFiles,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { TASK_BRANCH_PREFIX, taskSlug, taskWorktree } from "./task-branch.ts";
import type { StoredTask, TaskFile } from "./task-file.ts";
import { type MiseSnapshot, miseConfigChanges, miseConfigDigest, readMiseConfig, reviewMiseConfig } from "./task-mise-config.ts";
import { freeTaskPort, withTaskPorts } from "./task-port.ts";

/**
 * Agent tasks (§4.4, ADR-31): a prompt for Copilot CLI in its own worktree on a new branch from the repo's default
 * branch, so several tasks in one repo do not get in each other's way or into the user's working directory. A task
 * survives a daemon restart (`tasks.json`), and its session does not; the worktree and branch disappear only when the
 * task is ended, and changes that would be lost then only after the user confirms. Each task holds its own port while
 * it exists, and its worktree starts with the ignored files the repo root names for it (ADR-61).
 */

// The types below repeat the shape of the types from `vcs` (`WorktreeBase`, `WorktreeBranch`, `PendingWork`) instead of
// importing them, because a module does not import a neighbouring module (§4); the compiler checks they match where
// `facade.ts` passes `Vcs` as `TasksVcs` (the dependencies of `Agents`).

/** Where a task starts from: the default branch (`null` with a detached HEAD) and the base commit. */
interface TaskBase {
  branch: string | null;
  commit: string;
}

/** The task branch in its worktree, with the base commit. */
interface TaskWork {
  repoDir: string;
  worktree: string;
  branch: string;
  base: string;
}

/** What would be lost when ending a task (`PendingWork` in `vcs`). */
interface TaskPendingWork {
  uncommitted: number;
  strayCommits: number;
  branchCommits: number;
  unregisteredDir: boolean;
}

/** What tasks need from `vcs` (worktrees and branches, ADR-31); wired in the facade. */
export interface TasksVcs {
  defaultBase(dir: string): Promise<TaskBase>;
  addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void>;
  copyIncludedFiles(repoDir: string, worktree: string): Promise<IncludedFiles>;
  removeWorktree(repoDir: string, path: string): Promise<void>;
  deleteBranch(repoDir: string, branch: string): Promise<void>;
  pendingWork(work: TaskWork): Promise<TaskPendingWork>;
  worktreeChanges(dir: string, base: string, maxPatchBytes: number, paths: readonly string[]): Promise<TaskChanges>;
}

/** Copilot CLI sessions from `Agents`, in which tasks run. */
interface TaskSessions {
  /** Copilot CLI in the task's worktree with the task's arguments (the prompt, then `promptOnStart`, or a resume). */
  launch(spec: { repo: string; cwd: string; task: string; args: readonly string[]; promptOnStart: boolean }): Promise<Session>;
  /** The task's sessions, newest first. */
  of(task: string): Session[];
  /** Removes an ended session from the list. */
  close(session: string): void;
}

export interface AgentTasksDeps {
  vcs: TasksVcs;
  repos: { repoPath(id: string): Promise<string> };
  sessions: TaskSessions;
  file: TaskFile;
  /** Some process group still works in this directory (`procs.liveIn`): a mise task in the worktree locks its files on Windows. */
  liveIn: (dir: string) => boolean;
  /** The task worktrees directory in the state directory; outside the projects folder, so the repo list does not see them. */
  worktreesDir: string;
  openEditor: (dir: string) => void;
  log: (msg: string) => void;
}

/** Where a task comes from: the form (without a title and a proposer) or an approved proposal (ADR-39), whose identifier it takes. */
export interface TaskOrigin {
  id: string;
  title: string | null;
  proposedBy: ProposedBy | null;
}

/** A task from the file with the worktree that follows from it, and its port (one given when it was read, if it had none). */
type KnownTask = StoredTask & TaskWork & { port: number };

/**
 * Other tasks read at once for shared files: each read is several git commands, and a task panel asks every few
 * seconds, so a repo with many tasks must not start dozens of git processes at a time (slow on Windows).
 */
const SHARED_FILES_CONCURRENCY = 3;

export class AgentTasks {
  readonly #deps: AgentTasksDeps;
  /** Newest first. */
  #tasks: KnownTask[];
  /** Tasks with an action in progress (start, resume, end); a second one at the same time is `bad_request`. */
  readonly #busy = new Set<string>();
  /** Ports of tasks being created, not on the list yet: two tasks created at once must not get the same one. */
  readonly #creatingPorts = new Set<number>();
  /** Tasks being ended: computing changes refuses, because the worktree is about to disappear. */
  readonly #removing = new Set<string>();
  /** The task's change computations in progress (several windows at once): ending waits until git stops reading the worktree. */
  readonly #reading = new Map<string, Set<Promise<unknown>>>();

  constructor(deps: AgentTasksDeps) {
    this.#deps = deps;
    const stored = deps.file.read();
    const ported = withTaskPorts(stored);
    this.#tasks = ported.map((task) => this.#known(task));
    if (ported.some((task, i) => task.port !== stored[i]?.port)) this.#save(this.#tasks);
  }

  list(): Task[] {
    return this.#tasks.map(view);
  }

  /**
   * A worktree on a new branch from the default branch and Copilot CLI in it with the prompt as its first message; the
   * title names the branch, and without one the prompt.
   */
  async create(repo: string, prompt: string, { id, title, proposedBy }: TaskOrigin): Promise<Task> {
    const repoDir = await this.#deps.repos.repoPath(repo);
    const base = await asRepoUnavailable(repo, this.#deps.vcs.defaultBase(repoDir));
    const task = this.#known({
      id,
      repo,
      repoDir,
      prompt,
      branch: `${TASK_BRANCH_PREFIX}${taskSlug(title ?? prompt, id)}`,
      baseBranch: base.branch,
      base: base.commit,
      createdAt: new Date().toISOString(),
      title,
      proposedBy,
      summary: null,
      trustedMiseConfig: null,
      port: freeTaskPort([...this.#tasks.map((t) => t.port), ...this.#creatingPorts]),
      included: NO_INCLUDED_FILES,
    });
    this.#creatingPorts.add(task.port);
    return this.#exclusive(id, async () => {
      mkdirSync(dirname(task.worktree), { recursive: true });
      await asRepoUnavailable(repo, this.#deps.vcs.addWorktree(repoDir, task.worktree, task.branch, task.base));
      task.included = await this.#copyIncludedFiles(task);
      // The mise config of the fresh worktree is the base commit's and the ignored files copied from the repo root, whose
      // config the user trusted (ADR-59, ADR-61).
      task.trustedMiseConfig = await this.#initialMiseConfig(task);
      // Saved before the session starts: the worktree is already on disk and must not disappear from the list if the daemon crashes.
      this.#save([task, ...this.#tasks]);
      try {
        // `=` instead of a separate argument, so that a prompt starting with `-` is not a Copilot CLI option.
        await this.#launch(task, [`--session-id=${id}`, `--interactive=${prompt}`], true);
      } catch (err) {
        // A failed cleanup leaves the task on the list, so that the user can end it themselves.
        await this.#whileRemoving(id, () => this.#discard(task, false)).then(
          () => this.#save(this.#tasks.filter((t) => t.id !== id)),
          (e: unknown) => this.#deps.log(`cleaning up task ${id}: ${messageOf(e)}`),
        );
        throw err;
      }
      return view(task);
    }).finally(() => this.#creatingPorts.delete(task.port));
  }

  /** A new session for a task without a running session; Copilot CLI resumes the task's conversation, because it has the task's UUID. */
  resume(id: string): Promise<Task> {
    const task = this.#get(id);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "resuming");
      this.#closeSessions(task);
      await this.#launch(task, [`--resume=${id}`], false);
      return view(task);
    });
  }

  /** A task by identifier (`not_found` when it does not exist). */
  task(id: string): Task {
    return view(this.#get(id));
  }

  /** A task by identifier or `undefined` when it does not exist (waiting for a proposal that is not a task yet). */
  find(id: string): Task | undefined {
    const task = this.#tasks.find((t) => t.id === id);
    return task && view(task);
  }

  /** An action on the task is in progress (start, resume, end), e.g. the session of a new task is still starting. */
  busy(id: string): boolean {
    return this.#busy.has(id);
  }

  /** A summary from the task session (`report_result`, ADR-39); a later one replaces the earlier one and survives a daemon restart. */
  setSummary(id: string, text: string): Task {
    const summarized = { ...this.#get(id), summary: { text, reportedAt: new Date().toISOString() } };
    this.#save(this.#tasks.map((t) => (t.id === id ? summarized : t)));
    return view(summarized);
  }

  changes(id: string): Promise<TaskChanges> {
    return this.#readChanges(id, PATCH_MAX_BYTES, []);
  }

  /**
   * Changes without the diff, with at most `TASK_SUMMARY_MAX_FILES` files, for the agent's context (the MCP tool
   * `get_session`); an agent that wants the content reads the worktree itself.
   */
  async summary(id: string): Promise<TaskChangesSummary> {
    const { files, commits, uncommitted } = await this.#readChanges(id, 0, []);
    return { ...capFiles(files), commits, uncommitted };
  }

  /**
   * The changes with their diff for an agent (MCP tool `get_task_changes`), so a session that handed out the task can
   * review it: only under `paths` (git pathspecs; none is the whole worktree), with the diff cut within `maxPatchBytes`.
   */
  async agentChanges(id: string, maxPatchBytes: number, paths: readonly string[]): Promise<AgentTaskChanges> {
    const { files, ...rest } = await this.#readChanges(id, maxPatchBytes, paths);
    return { ...rest, ...capFiles(files) };
  }

  /**
   * Shared files (ADR-44): files changed both in this task and in another task of the same repo. Changes of another task
   * that cannot be read (being ended, worktree deleted by hand, broken index) are left out, because this is only a
   * warning; a failure to read this task's own changes is reported as in `changes`. A cut-off file list (`truncated`)
   * can miss a shared file, which is acceptable for a warning.
   */
  async sharedFiles(id: string): Promise<TaskSharedFiles[]> {
    const own = this.#get(id);
    const changed = new Set((await this.#readChanges(id, 0, [])).files.map((f) => f.path));
    const others = this.#tasks.filter((t) => t.repo === own.repo && t.id !== id);
    const theirs = await mapLimit(others, SHARED_FILES_CONCURRENCY, async (other) => ({
      task: other.id,
      files: (await this.#tryChangedPaths(other.id)).filter((path) => changed.has(path)),
    }));
    return theirs.filter((t) => t.files.length > 0);
  }

  /** Paths changed in a task, or none when its changes cannot be read for a known reason (`DomainError`). */
  async #tryChangedPaths(id: string): Promise<string[]> {
    try {
      return (await this.#readChanges(id, 0, [])).files.map((f) => f.path);
    } catch (err) {
      if (err instanceof DomainError) return [];
      throw err;
    }
  }

  #readChanges(id: string, maxPatchBytes: number, paths: readonly string[]): Promise<TaskChanges> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is already being ended");
    const task = this.#existingWorktree(id);
    const reading = asRepoUnavailable(task.branch, this.#deps.vcs.worktreeChanges(task.worktree, task.base, maxPatchBytes, paths));
    const reads = this.#reading.get(id) ?? new Set();
    this.#reading.set(id, reads.add(reading));
    void reading
      .catch(() => {})
      .finally(() => {
        reads.delete(reading);
        if (reads.size === 0) this.#reading.delete(id);
      });
    return reading;
  }

  /** The worktree's mise config against the trusted one (ADR-59), with the text of each changed file for the user to read. */
  miseConfig(id: string): Promise<TaskMiseConfig> {
    const task = this.#existingWorktree(id);
    return reviewMiseConfig(task.worktree, task.trustedMiseConfig);
  }

  /**
   * The user trusts the worktree's current mise config (ADR-59). `digest` is the one they saw: a config the agent
   * changed again in the meantime is refused, so the trust never covers a version nobody looked at.
   */
  async trustMiseConfig(id: string, digest: string): Promise<TaskMiseConfig> {
    const task = this.#existingWorktree(id);
    const current = await readMiseConfig(task.worktree);
    if (miseConfigDigest(current) !== digest)
      throw new DomainError("bad_request", `the mise config of task ${task.branch} changed again; review it before trusting it`);
    const trusted = { ...this.#get(id), trustedMiseConfig: current };
    this.#save(this.#tasks.map((t) => (t.id === id ? trusted : t)));
    return { neverTrusted: false, changes: [], digest };
  }

  /**
   * The worktree of a task of `repo` for running a mise task in it (ADR-59), only while it has the mise config the user
   * trusted and the task is not being ended: `mise_unavailable` names the changed files, and only the user can trust
   * them, in the task's panel.
   */
  async trustedWorktree(id: string, repo: string): Promise<{ worktree: string; port: number }> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    const task = this.#existingWorktree(id);
    if (task.repo !== repo) throw new DomainError("bad_request", `task ${task.branch} is in ${task.repo}, not in ${repo}`);
    const changes = miseConfigChanges(task.trustedMiseConfig ?? {}, await readMiseConfig(task.worktree));
    if (changes.length > 0)
      throw new DomainError(
        "mise_unavailable",
        `the mise config in the worktree of task ${task.branch} changed since the user trusted it (${changes.map((c) => c.path).join(", ")}); ` +
          "only the user can trust it, in the task's panel in Trackwall",
      );
    return { worktree: task.worktree, port: task.port };
  }

  openEditor(id: string): void {
    this.#deps.openEditor(this.#existingWorktree(id).worktree);
  }

  /**
   * Ending a task: removes the worktree, and without `keepBranch` also the branch. Uncommitted files and commits outside
   * the branch, and when removing the branch also the task's commits, are lost only with `discardChanges`; otherwise
   * `unsaved_changes` with what would be lost.
   */
  remove(id: string, keepBranch: boolean, discardChanges: boolean): Promise<void> {
    const task = this.#get(id);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "ending it");
      if (this.#deps.liveIn(task.worktree))
        throw new DomainError(
          "bad_request",
          `a process started by Trackwall still runs in the worktree of task ${task.branch}; stop it before ending the task`,
        );
      await this.#whileRemoving(id, async () => {
        if (!discardChanges) await this.#refuseLoss(task, keepBranch);
        await this.#discard(task, keepBranch);
      });
      this.#closeSessions(task);
      this.#save(this.#tasks.filter((t) => t.id !== id));
    });
  }

  /** A `job` that deletes the worktree only once git has stopped reading it; a new change computation meanwhile refuses. */
  async #whileRemoving(id: string, job: () => Promise<void>): Promise<void> {
    this.#removing.add(id);
    try {
      await Promise.allSettled(this.#reading.get(id) ?? []);
      await job();
    } finally {
      this.#removing.delete(id);
    }
  }

  async #refuseLoss(task: KnownTask, keepBranch: boolean): Promise<void> {
    const pending = await asRepoUnavailable(task.branch, this.#deps.vcs.pendingWork(task));
    const lost = [
      pending.unregisteredDir &&
        `directory ${task.worktree} with all its contents, because git does not know it as a worktree (interrupted removal, or the repo was moved or deleted)`,
      pending.uncommitted > 0 && `uncommitted changes in the worktree (${pending.uncommitted})`,
      pending.strayCommits > 0 && `commits outside the branch, from a detached HEAD (${pending.strayCommits})`,
      !keepBranch && pending.branchCommits > 0 && `commits on branch ${task.branch} (${pending.branchCommits})`,
    ].filter((s) => s !== false);
    if (lost.length > 0) throw new DomainError("unsaved_changes", `ending the task would delete: ${lost.join(", ")}`);
  }

  /** The worktree (with uncommitted and ignored files) and, without `keepBranch`, the branch. */
  async #discard(task: KnownTask, keepBranch: boolean): Promise<void> {
    await asRepoUnavailable(task.branch, this.#deps.vcs.removeWorktree(task.repoDir, task.worktree));
    if (!keepBranch) await asRepoUnavailable(task.branch, this.#deps.vcs.deleteBranch(task.repoDir, task.branch));
  }

  /** A failure to copy does not stop the task: the agent can still work, and the panel shows what is missing. */
  async #copyIncludedFiles(task: KnownTask): Promise<IncludedFiles> {
    try {
      return await this.#deps.vcs.copyIncludedFiles(task.repoDir, task.worktree);
    } catch (err) {
      this.#deps.log(`copying the included files of task ${task.id}: ${messageOf(err)}`);
      return { files: [], problems: [`copying failed: ${messageOf(err)}`] };
    }
  }

  /** A worktree whose mise config cannot be read gets no trust: the user can trust it in the task panel. */
  async #initialMiseConfig(task: KnownTask): Promise<MiseSnapshot | null> {
    try {
      return await readMiseConfig(task.worktree);
    } catch (err) {
      this.#deps.log(`reading the mise config of task ${task.id}: ${messageOf(err)}`);
      return null;
    }
  }

  async #launch(task: KnownTask, args: readonly string[], promptOnStart: boolean): Promise<void> {
    await this.#deps.sessions.launch({ repo: task.repo, cwd: task.worktree, task: task.id, args, promptOnStart });
  }

  /** A running session writes in the worktree and holds its files (on Windows it blocks deletion), so stop it first. */
  #refuseRunning(task: KnownTask, action: string): void {
    if (this.#deps.sessions.of(task.id).some((s) => s.run.kind !== "exited"))
      throw new DomainError("bad_request", `task ${task.branch} has a running session; stop it before ${action}`);
  }

  /** The task's ended sessions disappear from the list. */
  #closeSessions(task: KnownTask): void {
    for (const session of this.#deps.sessions.of(task.id)) this.#deps.sessions.close(session.id);
  }

  async #exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new DomainError("bad_request", "another action is already running on this task");
    this.#busy.add(id);
    try {
      return await run();
    } finally {
      this.#busy.delete(id);
    }
  }

  #existingWorktree(id: string): KnownTask {
    const task = this.#get(id);
    if (!existsSync(task.worktree))
      throw new DomainError("not_found", `the worktree of task ${task.branch} does not exist (${task.worktree})`);
    return task;
  }

  #get(id: string): KnownTask {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) throw new DomainError("not_found", `no task ${id}`);
    return task;
  }

  #known(task: StoredTask & { port: number }): KnownTask {
    return { ...task, worktree: taskWorktree(this.#deps.worktreesDir, task.repo, task.branch) };
  }

  #save(tasks: KnownTask[]): void {
    this.#deps.file.write(tasks.map(({ worktree: _, ...stored }) => stored));
    this.#tasks = tasks;
  }
}

/**
 * At most `TASK_SUMMARY_MAX_FILES` files for an agent's context. A file list git cut short has tens of thousands of
 * entries, so `filesTruncated` covers it too.
 */
function capFiles(files: ChangedFile[]): { files: ChangedFile[]; filesTruncated: boolean } {
  return { files: files.slice(0, TASK_SUMMARY_MAX_FILES), filesTruncated: files.length > TASK_SUMMARY_MAX_FILES };
}

function view({ repoDir: _, trustedMiseConfig: __, ...task }: KnownTask): Task {
  return task;
}

/** A git error in the repo or the task's worktree as `repo_unavailable` with git's message. */
function asRepoUnavailable<T>(label: string, work: Promise<T>): Promise<T> {
  return work.catch((err: unknown) => {
    throw new DomainError("repo_unavailable", `${label}: ${messageOf(err)}`);
  });
}
