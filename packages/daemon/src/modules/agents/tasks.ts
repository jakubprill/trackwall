import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentTaskChanges,
  type ChangedFile,
  type CreatedChange,
  firstAttempt,
  HANDED_TO_SUPERVISOR,
  type IncludedFiles,
  type JavaNavigationStatus,
  mayHandToSupervisor,
  noIncludedFiles,
  PATCH_MAX_BYTES,
  type ProposedBy,
  type ReportedSummary,
  type ReproTest,
  type Session,
  type SessionView,
  TASK_SUMMARY_MAX_FILES,
  type Task,
  type TaskApprovals,
  type TaskChange,
  type TaskChanges,
  type TaskChangesSummary,
  type TaskHandoffState,
  type TaskMiseConfig,
  type TaskRefresh,
  type TaskSharedFiles,
  type TaskWorktree,
  type TaskWorktreeLoss,
  type TaskWorktreeSize,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { approvalArgs } from "./copilot-command.ts";
import type { LspServer } from "./copilot-plugin.ts";
import { SANDBOX_ARG } from "./copilot-sandbox.ts";
import { type ConversationUse, NO_CONVERSATION_USE } from "./copilot-usage-log.ts";
import { type EndedTaskFacts, type EndedTaskGit, endedTaskFacts } from "./ended-task.ts";
import { offeredAfter } from "./impact-proposals.ts";
import type { JavaNavigationServers } from "./java-navigation-servers.ts";
import { modelArgs } from "./model-args.ts";
import { taskSlug, taskWorktree } from "./task-branch.ts";
import type { ChangeFacts } from "./task-change.ts";
import type { StoredTask, TaskFile } from "./task-file.ts";
import { type HandoffFacts, type HandoffGit, handoffState, type TaskHandoff } from "./task-handoff.ts";
import { type MiseSnapshot, miseConfigChanges, miseConfigDigest, readMiseConfig, reviewMiseConfig } from "./task-mise-config.ts";
import { planFirstMessage } from "./task-plan.ts";
import { freeTaskPort, withTaskPorts } from "./task-port.ts";
import { folderSize, lastActivity } from "./task-worktrees.ts";

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

/** Included files with the hash of each one's content from the root. */
type CopiedFiles = IncludedFiles & { sha256: Record<string, string> };

/** What would be lost when ending a task (`PendingWork` in `vcs`). */
interface TaskPendingWork {
  uncommitted: number;
  strayCommits: number;
  branchCommits: number;
  unregisteredDir: boolean;
}

/** What tasks need from `vcs` (worktrees and branches, ADR-31); wired in the facade. */
export interface TasksVcs extends HandoffGit, EndedTaskGit {
  /** HEAD, or the newest commit below it on its first-parent line that is not one of `skip`; `null` without commits. */
  newestCommitBesides(dir: string, skip: ReadonlySet<string>): Promise<string | null>;
  /** Whether two commits hold the same files (`false` for an `a` the repo does not have). */
  sameTree(dir: string, a: string, b: string): Promise<boolean>;
  defaultBase(dir: string): Promise<TaskBase>;
  addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void>;
  /** With the SHA-256 of each included file's content as the root had it (`sha256` by path). */
  copyIncludedFiles(repoDir: string, worktree: string): Promise<CopiedFiles>;
  removeWorktree(repoDir: string, path: string): Promise<void>;
  deleteBranch(repoDir: string, branch: string): Promise<void>;
  pendingWork(work: TaskWork): Promise<TaskPendingWork>;
  worktreeChanges(dir: string, base: string, maxPatchBytes: number, paths: readonly string[]): Promise<TaskChanges>;
  /** The files in which merging two branches of the repo would conflict; `null` when git cannot tell (ADR-230). */
  trialMergeConflicts(repoDir: string, ours: string, theirs: string): Promise<string[] | null>;
  /** The newest commits of HEAD in `dir`: the cleanup reads when the task last committed (ADR-210). */
  log(dir: string, limit: number): Promise<{ date: string }[]>;
  /** One hash of what the worktree's files hold beyond `base` (ADR-209). */
  worktreeFingerprint(dir: string, base: string): Promise<string>;
  discardFingerprint(dir: string, base: string): Promise<string | null>;
}

/**
 * A start of a task's session in its view (ADR-137), with the model and approvals arguments: in a terminal the
 * arguments also carry the prompt (then `promptOnStart`) or a resume; in the conversation view the prompt is the first
 * message of a new conversation, or the conversation to go on with is loaded.
 */
export type TaskLaunch = { repo: string; cwd: string; task: string; args: readonly string[] } & (
  | {
      view: "terminal";
      promptOnStart: boolean;
      lspServers: Record<string, LspServer>;
      /** Copilot CLI's id of the conversation, the task's id that `--session-id` and `--resume` name, not the session's. */
      conversation: string;
    }
  | {
      view: "conversation";
      load: string | undefined;
      firstMessage: string | undefined;
      /** Whether the agent starts in Plan mode, before the first message: its plan waits for approval (ADR-229). */
      planMode: boolean;
    }
);

/** Copilot CLI sessions from `Agents`, in which tasks run. */
interface TaskSessions {
  /** Copilot CLI in the task's worktree; resolves to Copilot CLI's id of the conversation in the conversation view. */
  launch(spec: TaskLaunch): Promise<string | undefined>;
  /** The task's sessions, newest first. */
  of(task: string): Session[];
  /** Removes an ended session from the list. */
  close(session: string): void;
}

export interface AgentTasksDeps {
  vcs: TasksVcs;
  repos: {
    repoPath(id: string): Promise<string>;
    /** The task worktrees folder for a new task (ADR-84), made when it is the default one in `.trackwall` (ADR-125). */
    newTaskWorktreesDir(): Promise<string>;
    /** What a new task's branch starts with (ADR-239); `invalid_config` for a bad `taskBranchPrefix`. */
    taskBranchPrefix(): string;
  };
  /** The tasks' jdtls (ADR-99), shared with repo sessions (ADR-175). */
  javaNavigation: JavaNavigationServers;
  /**
   * Whether a new task with these approvals runs in Copilot CLI's sandbox (ADR-181); `bad_request` when it should and
   * the sandbox cannot run on this computer.
   */
  sandbox: (approvals: TaskApprovals) => Promise<boolean>;
  sessions: TaskSessions;
  file: TaskFile;
  /** Some process group still works in this directory (`procs.liveIn`): a mise task in the worktree locks its files on Windows. */
  liveIn: (dir: string) => boolean;
  /** Closes the user's folder terminal in the task's worktree (ADR-185), once nothing else refuses the task's end. */
  closeFolderTerminal: (task: string) => Promise<void>;
  /** Stops the task's reproduction check and removes its copy before the task ends (`reproduction`, ADR-227). */
  stopReproductionCheck: (task: string) => Promise<void>;
  /** `worktrees/` in the state directory, where tasks saved before ADR-84 (without `worktreesDir`) have their worktrees. */
  legacyWorktreesDir: string;
  /** Task `task`'s round commits that the push has not squashed yet (ADR-168), which a handoff looks past (ADR-144). */
  roundCommits: (task: string) => ReadonlySet<string>;
  /** What a conversation used over its life and on which models, from Copilot CLI's event log (ADR-228). */
  conversationUse: (conversation: string) => Promise<ConversationUse>;
  openEditor: (dir: string) => void;
  /** A task was created and its first session started: from the form, a proposal, a routine, a handoff or a part of a change. */
  onCreated: (task: Task) => void;
  log: (msg: string) => void;
}

/**
 * Where a task comes from: the form (without a title, a proposer and a model) or an approved proposal (ADR-39), whose
 * identifier it takes, with the model the user approved (ADR-98).
 */
export interface TaskOrigin {
  id: string;
  title: string | null;
  proposedBy: ProposedBy | null;
  /** The model the task's sessions run on (ADR-98); `null` for Copilot CLI's default. */
  model: string | null;
  /** How the task's sessions answer tool approvals (ADR-105). */
  approvals: TaskApprovals;
  /** Whether its agent plans first, in Copilot CLI's Plan mode, until the user approves the plan (ADR-229). */
  planFirst: boolean;
  /** Whether the task's sessions get the Java language server (ADR-99). */
  javaNavigation: boolean;
  /** The board item the task works on (ADR-133); `null` for none. */
  item: string | null;
  /** Whether the task's sessions show as a terminal or in the conversation view (ADR-137). */
  view: SessionView;
  /** The change the task is a part of (ADR-171), whose earlier parts are already on the list; `null` for a task on its own. */
  change: TaskChange | null;
  /** The task this one retries on another model (ADR-233); `null` for a first attempt. */
  retryOf: string | null;
}

/**
 * What every part of a change starts with (ADR-171): its identity and place come from the change. No part plans first
 * (ADR-229): the change's parts start one after another, each on the work of the part before it.
 */
export type ChangeOrigin = Omit<TaskOrigin, "id" | "change" | "planFirst" | "retryOf">;

/** What the user chooses for a task they start: everything of its origin but the identity a proposal or a change gives it. */
export type TaskOptions = Omit<TaskOrigin, "id" | "title" | "proposedBy" | "change" | "retryOf">;

/**
 * Where a retry on another model starts (ADR-233): the base of the task it retries, and that task's handoff, so its
 * agent reads the same handed work.
 */
interface RetryStart {
  base: TaskBase;
  handoff: TaskHandoff | null;
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
  /** Parts of a change made but not started yet (`createChange`, ADR-171): no other action may run on them meanwhile. */
  readonly #held = new Set<string>();
  /** Ports of tasks being created, not on the list yet: two tasks created at once must not get the same one. */
  readonly #creatingPorts = new Set<number>();
  /** Repo to the number of its tasks being created: they are not on the list until their worktree is on disk. */
  readonly #creatingIn = new Map<string, number>();
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

  /** Whether `tasks.json` was read at daemon start: without it the list may not be every task the user still wants. */
  get taskListRead(): boolean {
    return this.#deps.file.taskListRead;
  }

  /** A task of the repo is being created, so its worktree may be half made (a repo removal waits for it, ADR-83). */
  creatingIn(repo: string): boolean {
    return (this.#creatingIn.get(repo) ?? 0) > 0;
  }

  /**
   * A worktree on a new branch from the default branch and Copilot CLI in it with the prompt as its first message; the
   * title names the branch, and without one the prompt.
   */
  async create(repo: string, prompt: string, origin: TaskOrigin): Promise<Task> {
    return view(await this.#creating(repo, () => this.#create(repo, prompt, origin, "launch")));
  }

  /**
   * A change (ADR-171): a task per part in the parts' order, all on one branch name. Every part's worktree is made before
   * the first session starts, so each session's instructions name all its siblings; until its own session starts, a part
   * is held, so no resume, end or handing over gets between. The sessions then start in order, and each part takes as its
   * handoff the part right before it that is still on the list, since an earlier one whose session could not start is
   * gone. A part that cannot be made or started is in `failed`, in the parts' order, and the others go on. The first
   * part made gets `firstId`: a proposed change's id, which its proposer waits on.
   */
  async createChange(
    parts: readonly { repo: string; prompt: string }[],
    origin: ChangeOrigin,
    firstId: string = randomUUID(),
  ): Promise<CreatedChange> {
    const change = randomUUID();
    const failures: { position: number; repo: string; err: unknown }[] = [];
    const held: { position: number; task: KnownTask }[] = [];
    for (const [position, { repo, prompt }] of parts.entries()) {
      // A proposed change's id goes to the first part made, so a part that cannot be made does not leave it unused.
      const partOrigin = {
        ...origin,
        planFirst: false,
        id: held.length === 0 ? firstId : randomUUID(),
        change: { id: change, position },
        retryOf: null,
      };
      await this.#creating(repo, () => this.#create(repo, prompt, partOrigin, "hold")).then(
        (task) => held.push({ position, task }),
        (err: unknown) => failures.push({ position, repo, err }),
      );
    }
    const tasks: Task[] = [];
    for (const { position, task: part } of held)
      await this.#launchHeld(part).then(
        (task) => tasks.push(task),
        (err: unknown) => failures.push({ position, repo: part.repo, err }),
      );
    failures.sort((a, b) => a.position - b.position);
    if (tasks.length === 0 && failures[0]) throw failures[0].err;
    return { tasks, failed: failures.map(({ repo, err }) => ({ repo, message: messageOf(err) })) };
  }

  /** A task of the repo is being created while `run` runs, so a repo removal waits for it (ADR-83). */
  async #creating<T>(repo: string, run: () => Promise<T>): Promise<T> {
    this.#creatingIn.set(repo, (this.#creatingIn.get(repo) ?? 0) + 1);
    try {
      return await run();
    } finally {
      this.#creatingIn.set(repo, (this.#creatingIn.get(repo) ?? 1) - 1);
    }
  }

  async #create(
    repo: string,
    prompt: string,
    { id, title, proposedBy, model, approvals, planFirst, javaNavigation, item, view: sessionView, change, retryOf }: TaskOrigin,
    launch: "launch" | "hold",
    retry: RetryStart | null = null,
  ): Promise<KnownTask> {
    // Refused before the worktree exists: a task that asked for Java navigation would otherwise start without it, and
    // one that should run in the sandbox would run with the user's full access.
    if (javaNavigation) this.#deps.javaNavigation.assertCanStart(sessionView, "a task");
    // Copilot CLI's Plan mode is a mode of its ACP session; a terminal has no way for the daemon to switch it (ADR-229).
    if (planFirst && sessionView !== "conversation") throw new DomainError("bad_request", "Plan first needs the conversation view (Chat)");
    const sandbox = await this.#deps.sandbox(approvals);
    const repoDir = await this.#deps.repos.repoPath(repo);
    const base = retry?.base ?? (await asRepoUnavailable(repo, this.#deps.vcs.defaultBase(repoDir)));
    const branchPrefix = this.#deps.repos.taskBranchPrefix();
    const worktreesDir = await this.#deps.repos.newTaskWorktreesDir();
    // A part of a change takes its handoff when its session starts (`#launchHeld`), once the parts before it started.
    const handoff =
      retry !== null
        ? await this.#retriedHandoff(retry.handoff)
        : change === null
          ? await this.#handoffFrom(this.#tasks.find((t) => t.id === proposedBy?.task))
          : null;
    const task = this.#known({
      id,
      repo,
      repoDir,
      worktreesDir,
      prompt,
      // The parts of a change share one branch name (ADR-171); each is in its own repo, so the worktrees do not collide.
      branch: `${branchPrefix}${taskSlug(title ?? prompt, change?.id ?? id)}`,
      baseBranch: base.branch,
      base: base.commit,
      createdAt: new Date().toISOString(),
      title,
      proposedBy,
      model,
      approvals,
      plan: planFirst ? "planning" : null,
      javaNavigation,
      sandbox,
      item,
      view: sessionView,
      conversation: null,
      summary: null,
      inReview: false,
      stoppedAtTokenBudget: false,
      handoff,
      change,
      retryOf,
      impactProposed: {},
      trustedMiseConfig: null,
      port: freeTaskPort([...this.#tasks.map((t) => t.port), ...this.#creatingPorts]),
      included: noIncludedFiles(),
    });
    this.#creatingPorts.add(task.port);
    return this.#exclusive(id, async () => {
      mkdirSync(dirname(task.worktree), { recursive: true });
      await asRepoUnavailable(repo, this.#deps.vcs.addWorktree(repoDir, task.worktree, task.branch, task.base));
      const { files, problems } = await this.#copyIncludedFiles(task);
      task.included = { files, problems };
      // The mise config of the fresh worktree is the base commit's and the ignored files copied from the repo root, whose
      // config the user trusted (ADR-59, ADR-61).
      task.trustedMiseConfig = await this.#initialMiseConfig(task);
      // Saved before the session starts: the worktree is already on disk and must not disappear from the list if the daemon crashes.
      this.#save([task, ...this.#tasks]);
      if (launch === "launch") await this.#launchNew(task);
      // Held before `#exclusive` lets go of it, so nothing acts on the part until `#launchHeld`.
      else this.#held.add(id);
      return task;
    }).finally(() => this.#creatingPorts.delete(task.port));
  }

  /** The first session of a part of a change that `createChange` held, with the part before it as its handoff (ADR-171). */
  async #launchHeld(part: KnownTask): Promise<Task> {
    this.#held.delete(part.id);
    return this.#exclusive(part.id, async () => {
      const before = part.change === null ? undefined : this.#partBefore(part.change);
      const task = { ...this.#get(part.id), handoff: await this.#handoffFrom(before) };
      this.#save(this.#tasks.map((t) => (t.id === task.id ? task : t)));
      await this.#launchNew(task);
      return view(task);
    });
  }

  /** The first session of a new task; when it cannot start, the task is ended again, its worktree and branch with it. */
  async #launchNew(task: KnownTask): Promise<void> {
    const { id } = task;
    try {
      await this.#launch(task, "new");
      // Only a task whose first session started counts: one that could not start is ended again below.
      this.#deps.onCreated(view(task));
    } catch (err) {
      // A failed cleanup leaves the task on the list, so that the user can end it themselves.
      await this.#whileRemoving(id, async () => {
        await this.#deps.closeFolderTerminal(id);
        await this.#discard(task, false);
      }).then(
        () => this.#save(this.#tasks.filter((t) => t.id !== id)),
        (e: unknown) => this.#deps.log(`cleaning up task ${id}: ${messageOf(e)}`),
      );
      throw err;
    }
  }

  /**
   * A new attempt at task `id` on `model` (ADR-233): a new task with its prompt, title, approvals, plan first, Java
   * navigation, view, handoff and `item` (the caller checks it is still on the board), from the same base commit and
   * base branch, so the two attempts start from the same code; `retryOf` names the task it retries. It reports to the
   * user, not to a proposer, whose coordination stays with the first attempt, which goes on as it is. The same model as
   * the task's is a second attempt to compare with the first (ADR-251). A part of a change starts with the other parts
   * on one branch name, so it is `bad_request`.
   */
  retry(id: string, model: string | null, item: string | null): Promise<Task> {
    const task = this.#get(id);
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    if (task.change !== null) throw new DomainError("bad_request", "a part of a change cannot be retried on its own");
    const origin: TaskOrigin = {
      id: randomUUID(),
      title: task.title,
      proposedBy: null,
      model,
      approvals: task.approvals,
      planFirst: task.plan !== null,
      javaNavigation: task.javaNavigation,
      item,
      view: task.view,
      change: null,
      retryOf: task.id,
    };
    const start = { base: { branch: task.baseBranch, commit: task.base }, handoff: task.handoff };
    return this.#creating(task.repo, () => this.#create(task.repo, task.prompt, origin, "launch", start)).then(view);
  }

  /**
   * A new session for a task without a running session, which goes on with the task's conversation: in a terminal
   * Copilot CLI keeps it under the task's UUID, in the conversation view under the id it chose (ADR-137). With `model`
   * (ADR-206; `null` for Copilot CLI's default) the task runs on it from now on, saved before the start, so a start that
   * fails keeps the user's choice for the next Resume: a task stuck on a model its provider does not serve gets out of it.
   */
  resume(id: string, model?: string | null): Promise<Task> {
    const task = this.#get(id);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "resuming");
      this.#closeSessions(task);
      const unstopped = this.#withStoppedAtTokenBudget(task, false);
      const resumed = model === undefined || model === unstopped.model ? unstopped : this.#withModel(unstopped, model);
      await this.#launch(resumed, "resume");
      return view(resumed);
    });
  }

  /** Whether the daemon stopped the task at its token budget since its last resume (ADR-237). */
  stoppedAtTokenBudget(id: string): boolean {
    return this.#get(id).stoppedAtTokenBudget;
  }

  /** The daemon stops the task's session at its token budget (ADR-237); a resume clears it. */
  markStoppedAtTokenBudget(id: string): void {
    this.#withStoppedAtTokenBudget(this.#get(id), true);
  }

  #withStoppedAtTokenBudget(task: KnownTask, stopped: boolean): KnownTask {
    if (task.stoppedAtTokenBudget === stopped) return task;
    const changed = { ...task, stoppedAtTokenBudget: stopped };
    this.#save(this.#tasks.map((t) => (t.id === task.id ? changed : t)));
    return changed;
  }

  #withModel(task: KnownTask, model: string | null): KnownTask {
    const changed = { ...task, model };
    this.#save(this.#tasks.map((t) => (t.id === task.id ? changed : t)));
    this.#deps.log(`task ${task.id} runs on ${model ?? "Copilot CLI's default model"} from now on`);
    return changed;
  }

  /**
   * Copies the files the repo root's `.worktreeinclude` names into the task's existing worktree again (ADR-61), for a
   * line added after the task started; `included` then says what the worktree has now. The copied files come from the
   * root, whose config the user trusted, so like at creation they join the trusted mise config (ADR-59), with the hash
   * of the root's content: a file the agent changes, before or after the copy, stays a change.
   */
  copyIncludedFilesAgain(id: string): Promise<Task> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    const task = this.#existingWorktree(id);
    return this.#exclusive(id, async () => {
      const { sha256, ...included } = await this.#copyIncludedFiles(task);
      const miseFiles = await this.#miseFilesNow(task);
      // Read after the copy: the user may have trusted the config while it ran.
      const latest = this.#get(id);
      const trustedMiseConfig =
        latest.trustedMiseConfig === null
          ? null
          : { ...latest.trustedMiseConfig, ...Object.fromEntries(Object.entries(sha256).filter(([path]) => miseFiles.has(path))) };
      const updated = { ...latest, included, trustedMiseConfig };
      this.#save(this.#tasks.map((t) => (t.id === id ? updated : t)));
      return view(updated);
    });
  }

  /**
   * Which paths of the worktree are mise files, to pick the copied ones that join the trusted config; none when the
   * config cannot be read (a link, too many files), which then stays a problem the task panel shows.
   */
  async #miseFilesNow(task: KnownTask): Promise<Set<string>> {
    try {
      return new Set(Object.keys(await readMiseConfig(task.worktree)));
    } catch (err) {
      this.#deps.log(`reading the mise config of task ${task.id}: ${messageOf(err)}`);
      return new Set();
    }
  }

  /** A task by identifier (`not_found` when it does not exist). */
  task(id: string): Task {
    return view(this.#get(id));
  }

  /** The worktree of task `id` of `repo` for the user's shell (ADR-185); refused while the task is being ended. */
  worktreeForShell(id: string, repo: string): string {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    const task = this.#get(id);
    if (task.repo !== repo) throw new DomainError("bad_request", `task ${id} is in ${task.repo}, not in ${repo}`);
    return task.worktree;
  }

  /** A task by identifier or `undefined` when it does not exist (waiting for a proposal that is not a task yet). */
  find(id: string): Task | undefined {
    const task = this.#tasks.find((t) => t.id === id);
    return task && view(task);
  }

  /** What task rounds need of a task (ADR-168): its worktree with the repo root it came from; `undefined` when there is none. */
  roundTask(id: string): (Task & { repoDir: string }) | undefined {
    const task = this.#tasks.find((t) => t.id === id);
    return task && { ...view(task), repoDir: task.repoDir };
  }

  /** An action on the task is in progress (start, resume, end), e.g. the session of a new task is still starting. */
  busy(id: string): boolean {
    return this.#busy.has(id) || this.#held.has(id);
  }

  /** What a session of task `id` is told about the task that handed it its work (ADR-143); `null` when no task did. */
  handoff(id: string): HandoffFacts | null {
    const handoff = this.#tasks.find((t) => t.id === id)?.handoff ?? null;
    if (handoff === null) return null;
    if (this.#tasks.some((t) => t.id === handoff.task)) return { ...handoff, ended: false };
    const { commit: _, ...ended } = handoff;
    return { ...ended, ended: true };
  }

  /**
   * The part of `change` right before `change.position` among the listed parts (ADR-171): the one whose work the part
   * builds on, as a handoff (ADR-143). An earlier part whose session could not start is no longer listed, so it is skipped.
   */
  #partBefore(change: TaskChange): KnownTask | undefined {
    return this.#parts(change.id)
      .filter((t) => t.change.position < change.position)
      .at(-1);
  }

  /** The listed parts of change `id` in their order (ADR-171). */
  #parts(id: string): (KnownTask & { change: TaskChange })[] {
    return this.#tasks
      .filter((t): t is KnownTask & { change: TaskChange } => t.change?.id === id)
      .sort((a, b) => a.change.position - b.change.position);
  }

  /** What a session of task `id` is told about the change it is a part of (ADR-171); `null` for a task on its own. */
  change(id: string): ChangeFacts | null {
    const change = this.#tasks.find((t) => t.id === id)?.change ?? null;
    if (change === null) return null;
    return { parts: this.#parts(change.id).map(({ id: task, repo, branch }) => ({ task, repo, branch })) };
  }

  /** The tasks task `id` handed their work to (ADR-143), while they last. */
  handedTo(id: string): string[] {
    return this.#tasks.filter((t) => t.handoff?.task === id).map((t) => t.id);
  }

  /**
   * Whether the branch of the task that handed task `id` its work holds other files than the commit `id` read last
   * (ADR-144): round commits are looked past (ADR-168), and so is a commit with the same files, such as the squash of the
   * rounds before the push.
   */
  async handoffMoved(id: string): Promise<boolean> {
    const handing = this.#handing(id);
    if (handing === null || handing.worktree === undefined) return false;
    const read = handing.handoff.commit;
    const head = await this.#handoffHead(handing.handoff.task, handing.worktree);
    if (head === null || head === read) return false;
    return !(await this.#deps.vcs.sameTree(handing.worktree, read, head));
  }

  /**
   * Where the branch of the task that handed task `id` its work is now and what changed since `id` read it, whose head
   * then counts as read (`get_handoff`, ADR-144); `null` when no task handed it its work.
   */
  async readHandoff(id: string): Promise<TaskHandoffState | null> {
    this.#get(id);
    const handing = this.#handing(id);
    if (handing === null) return null;
    const { handoff, worktree } = handing;
    const read = async () => {
      const branch = worktree === undefined ? undefined : { worktree, head: await this.#handoffHead(handoff.task, worktree) };
      return handoffState(handoff, branch, this.#deps.vcs);
    };
    const state = await asRepoUnavailable(handoff.branch, read());
    const { head } = state;
    if (head !== null && head !== handoff.commit && this.#tasks.some((t) => t.id === id))
      this.#save(this.#tasks.map((t) => (t.id === id ? { ...t, handoff: { ...handoff, commit: head } } : t)));
    return state;
  }

  /** Where task `handing`'s branch is as a handoff sees it: past its round commits (ADR-168). */
  #handoffHead(handing: string, worktree: string): Promise<string | null> {
    return this.#deps.vcs.newestCommitBesides(worktree, this.#deps.roundCommits(handing));
  }

  /** Task `id`'s handoff and the handing task's worktree, `undefined` once that task ended; `null` without a handoff. */
  #handing(id: string): { handoff: TaskHandoff; worktree: string | undefined } | null {
    const handoff = this.#tasks.find((t) => t.id === id)?.handoff ?? null;
    if (handoff === null) return null;
    return { handoff, worktree: this.#tasks.find((t) => t.id === handoff.task)?.worktree };
  }

  /**
   * The handoff of a task a task's session proposed (ADR-143): that task, read from the list, and the commit its branch is
   * at as the user approves. A handing task already ended, or a HEAD git cannot read, leaves the new task without one.
   */
  async #handoffFrom(from: KnownTask | undefined): Promise<TaskHandoff | null> {
    if (from === undefined) return null;
    const commit = await this.#handoffHead(from.id, from.worktree).catch((err: unknown) => {
      this.#deps.log(`reading the HEAD of task ${from.id} for its subtask: ${messageOf(err)}`);
      return null;
    });
    return commit === null ? null : { task: from.id, repo: from.repo, branch: from.branch, commit };
  }

  /**
   * The handoff of a retry (ADR-233): the handing task's branch as it is now, as a new subtask gets it, so the retry's
   * agent is not told it read a commit only the first attempt read; the first attempt's own once the handing task ended.
   */
  async #retriedHandoff(first: TaskHandoff | null): Promise<TaskHandoff | null> {
    if (first === null) return null;
    return (await this.#handoffFrom(this.#tasks.find((t) => t.id === first.task))) ?? first;
  }

  /** The endpoints and types each repo was offered a task for from task `id`'s impact (ADR-198, ADR-205); `{}` once the task is gone. */
  impactProposed(id: string): Readonly<Record<string, readonly string[]>> {
    return this.#tasks.find((t) => t.id === id)?.impactProposed ?? {};
  }

  /** Adds `keys` to what `repo` was offered from task `id`'s impact; nothing once the task is gone. */
  markImpactProposed(id: string, repo: string, keys: readonly string[]): void {
    const task = this.#tasks.find((t) => t.id === id);
    if (task === undefined) return;
    const offered = offeredAfter(task.impactProposed[repo] ?? [], keys);
    const marked = { ...task, impactProposed: { ...task.impactProposed, [repo]: offered } };
    this.#save(this.#tasks.map((t) => (t.id === id ? marked : t)));
  }

  /**
   * The user hands a task they started to the supervisor (ADR-155): it becomes the supervisor's work, in `tasks.json` too,
   * so it stays so after a restart; a task with a proposer already, or being ended, is `bad_request`.
   */
  handToSupervisor(id: string): Task {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    if (this.busy(id)) throw new DomainError("bad_request", "this task is still starting or busy; try again in a moment");
    const task = this.#get(id);
    if (!mayHandToSupervisor(task))
      throw new DomainError(
        "bad_request",
        "only a task you started yourself can be handed to the supervisor; this one already reports to its proposer",
      );
    const handed = { ...task, proposedBy: HANDED_TO_SUPERVISOR };
    this.#save(this.#tasks.map((t) => (t.id === id ? handed : t)));
    return view(handed);
  }

  /**
   * A summary from the task session (`report_result`, ADR-39) with its check steps (ADR-169) and its reproduction test
   * (ADR-222); a later one replaces the earlier one, steps and test included, and survives a daemon restart.
   */
  setSummary(id: string, report: ReportedSummary): Task {
    const reportedAt = new Date().toISOString();
    // A summary hands the work over for review (ADR-213).
    const summarized = { ...this.#get(id), summary: { ...report, reportedAt }, inReview: true };
    this.#save(this.#tasks.map((t) => (t.id === id ? summarized : t)));
    return view(summarized);
  }

  /**
   * The user approved the task's plan (ADR-229), once its session switched to Agent mode; `bad_request` for a task whose
   * plan does not wait for approval.
   */
  planApproved(id: string): Task {
    const task = this.#planWaiting(id);
    const approved: KnownTask = { ...task, plan: "approved" };
    this.#save(this.#tasks.map((t) => (t.id === id ? approved : t)));
    return view(approved);
  }

  /** The task, whose plan waits for the user's approval (ADR-229); `bad_request` otherwise. */
  assertPlanWaits(id: string): void {
    this.#planWaiting(id);
  }

  #planWaiting(id: string): KnownTask {
    const task = this.#get(id);
    if (task.plan !== "planning") throw new DomainError("bad_request", `task ${task.branch} has no plan waiting for approval`);
    return task;
  }

  /**
   * The task's agent got work again (the user's review or "Fix" of its pipeline, its proposer's message, ADR-213), so its work is no longer
   * waiting for review; `false` when it was not.
   */
  takeOutOfReview(id: string): boolean {
    const task = this.#get(id);
    if (!task.inReview) return false;
    this.#save(this.#tasks.map((t) => (t.id === id ? { ...task, inReview: false } : t)));
    return true;
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
    const theirs = await mapLimit(others, SHARED_FILES_CONCURRENCY, async (other): Promise<TaskSharedFiles | null> => {
      const files = (await this.#tryChangedPaths(other.id)).filter((path) => changed.has(path));
      if (files.length === 0) return null;
      return { task: other.id, files, conflicts: await this.#conflictsIn(files, own, other) };
    });
    return theirs.filter((t) => t !== null);
  }

  /**
   * Which of the shared `files` a trial merge of the two task branches leaves in conflict (ADR-230): only the
   * committed work, which a round commit (ADR-168) makes of every turn of the agent. A conflict in another file comes
   * from the default branch moving between the two bases, not from the other task, so it is left out.
   */
  async #conflictsIn(files: readonly string[], own: KnownTask, other: KnownTask): Promise<string[] | null> {
    const conflicts = await this.#deps.vcs.trialMergeConflicts(own.repoDir, own.branch, other.branch);
    return conflicts && files.filter((path) => conflicts.includes(path));
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
    return this.#readWorktree(id, (task) => this.#deps.vcs.worktreeChanges(task.worktree, task.base, maxPatchBytes, paths));
  }

  /**
   * The worktree of every task without a running session for the cleanup of old worktrees (ADR-210): its last activity
   * and what ending it with its branch kept would delete, read as the end reads it. A task being ended is left out.
   */
  async worktrees(now: Date): Promise<TaskWorktree[]> {
    const listed = this.#tasks.filter(
      (task) => !this.#removing.has(task.id) && this.#deps.sessions.of(task.id).every((session) => session.run.kind === "exited"),
    );
    return mapLimit(listed, SHARED_FILES_CONCURRENCY, async (task) => {
      const [loss, commits] = await Promise.all([
        this.#loss(task),
        existsSync(task.worktree) ? this.#tracked(task, this.#deps.vcs.log(task.worktree, 1)).catch(() => []) : [],
      ]);
      const lastActivityAt = lastActivity(task, this.#deps.sessions.of(task.id), commits[0]?.date ?? null, now);
      return { task: task.id, repo: task.repo, branch: task.branch, lastActivityAt, loss };
    });
  }

  /**
   * What ending the task with its branch kept would delete, with the fingerprint the end checks before it deletes it.
   * The fingerprint is read first, so work that comes before the counts is refused at the end rather than unnamed.
   */
  async #loss(task: KnownTask): Promise<TaskWorktreeLoss> {
    try {
      const fingerprint = await this.#tracked(task, this.#deps.vcs.discardFingerprint(task.worktree, task.base));
      const pending = await this.#tracked(task, this.#deps.vcs.pendingWork(task));
      if (pending.unregisteredDir) return { kind: "unknown", reason: "a folder git does not know as a worktree" };
      if (pending.uncommitted === 0 && pending.strayCommits === 0) return { kind: "none" };
      if (fingerprint === null) return { kind: "unknown", reason: "too many changed files to name here" };
      return { kind: "work", uncommitted: pending.uncommitted, strayCommits: pending.strayCommits, fingerprint };
    } catch (err) {
      return { kind: "unknown", reason: messageOf(err) };
    }
  }

  /**
   * How much disk the task's worktree takes, ignored files included (ADR-210); `not_found` once it is gone. Ending the
   * task stops the count, so the end does not wait for it.
   */
  async worktreeSize(id: string): Promise<TaskWorktreeSize> {
    return await this.#readWorktree(id, async (task) => ({
      task: id,
      ...(await folderSize(task.worktree, { stop: () => this.#removing.has(id) })),
    }));
  }

  /** The fingerprint of what the task's worktree holds (ADR-209), for a verification to tell when its verdict is outdated. */
  fingerprint(id: string): Promise<string> {
    return this.#readWorktree(id, (task) => this.#deps.vcs.worktreeFingerprint(task.worktree, task.base));
  }

  /** A git read of the task's worktree, which ending the task waits for before it deletes the worktree. */
  #readWorktree<T>(id: string, read: (task: KnownTask) => Promise<T>): Promise<T> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is already being ended");
    const task = this.#existingWorktree(id);
    return this.#tracked(task, read(task));
  }

  /**
   * The user's refresh of task `id` from its base branch (ADR-245): `refresh` works in the worktree as one of the task's
   * reads, which ending the task waits for, and the commit it merged becomes the task's base, so the task's changes stay
   * its own work. A git failure is `repo_unavailable`; a refusal keeps its own code.
   */
  async refresh(id: string, refresh: (task: Task & { repoDir: string }) => Promise<TaskRefresh>): Promise<TaskRefresh> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is already being ended");
    const task = this.#existingWorktree(id);
    const work = refresh({ ...view(task), repoDir: task.repoDir }).catch((err: unknown) => {
      throw err instanceof DomainError ? err : new DomainError("repo_unavailable", `${task.branch}: ${messageOf(err)}`);
    });
    const result = await this.#track(task, work);
    if (result.state === "refreshed" && this.#tasks.some((t) => t.id === id))
      this.#save(this.#tasks.map((t) => (t.id === id ? { ...t, base: result.base } : t)));
    return result;
  }

  /** `work` among the task's reads, which ending the task waits for before it deletes the worktree. */
  #tracked<T>(task: KnownTask, work: Promise<T>): Promise<T> {
    return this.#track(task, asRepoUnavailable(task.branch, work));
  }

  #track<T>(task: KnownTask, reading: Promise<T>): Promise<T> {
    const { id } = task;
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
    const task = this.#existingWorktree(id);
    const advice =
      "only the user can trust it, in the task's panel in Trackwall, and a session in Trackwall refused for it is told when they do";
    return { worktree: task.worktree, port: await this.#trustedPlace(id, repo, task.worktree, "the worktree of", advice) };
  }

  /**
   * The task port for a mise run in `dir`, a folder of task `id` of `repo`, while the task is not being ended and the
   * folder has the mise config the user trusted for the task's worktree; `place` names the folder in the refusal, and
   * `advice` says what to do about it.
   */
  async #trustedPlace(id: string, repo: string, dir: string, place: string, advice: string): Promise<number> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    const task = this.#existingWorktree(id);
    if (task.repo !== repo) throw new DomainError("bad_request", `task ${task.branch} is in ${task.repo}, not in ${repo}`);
    const changes = miseConfigChanges(task.trustedMiseConfig ?? {}, await readMiseConfig(dir));
    if (changes.length > 0)
      throw new DomainError(
        "mise_unavailable",
        `the mise config in ${place} task ${task.branch} changed since the user trusted it (${changes.map((c) => c.path).join(", ")}); ${advice}`,
      );
    return task.port;
  }

  /**
   * What a reproduction check of task `id` works with (ADR-227): its repo, worktree and base commit, the reproduction test
   * its agent last reported (`null` without one), the paths of the mise config the user trusted for its worktree, and the
   * folder of the check's copy of the repo (`reproCopyOf`). Refused while the task is being ended.
   */
  reproSubject(id: string): {
    repo: string;
    worktree: string;
    base: string;
    reproTest: ReproTest | null;
    miseConfigPaths: string[];
    copy: string;
  } {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    const task = this.#existingWorktree(id);
    return {
      repo: task.repo,
      worktree: task.worktree,
      base: task.base,
      reproTest: task.summary?.reproTest ?? null,
      miseConfigPaths: Object.keys(task.trustedMiseConfig ?? {}),
      copy: reproCopy(task.worktree),
    };
  }

  /**
   * The folder of task `id`'s reproduction check copy (ADR-227), next to its worktree in the task worktrees folder
   * (`<worktree>.repro`), so the copy gets the same mise config from the projects folder; also while the task is being
   * ended, so its check can remove the copy.
   */
  reproCopyOf(id: string): { repo: string; copy: string } {
    const task = this.#get(id);
    return { repo: task.repo, copy: reproCopy(task.worktree) };
  }

  /**
   * The copy of a reproduction check of a task of `repo` for a mise task run in it (ADR-227), only while it has the mise
   * config the user trusted for the task's worktree, as `trustedWorktree` requires of the worktree, and with the task port.
   */
  async trustedReproCopy(id: string, repo: string): Promise<{ dir: string; port: number }> {
    const task = this.#existingWorktree(id);
    const dir = reproCopy(task.worktree);
    if (!existsSync(dir)) throw new DomainError("not_found", `task ${task.branch} has no reproduction check copy`);
    const advice =
      "a reproduction check copies only the mise files the user trusted for the worktree, so a mise file the task deleted or one git ignores differs; " +
      "end the check here and run the test in the worktree instead";
    return { dir, port: await this.#trustedPlace(id, repo, dir, "the reproduction check's copy of", advice) };
  }

  openEditor(id: string): void {
    this.#deps.openEditor(this.#existingWorktree(id).worktree);
  }

  /**
   * Ending a task: removes the worktree, and without `keepBranch` also the branch. Uncommitted files and commits outside
   * the branch, and when removing the branch also the task's commits, are lost only with `discardChanges`; otherwise
   * `unsaved_changes` with what would be lost. Returns the facts of the ended task for the task journal (ADR-150),
   * read from its worktree before it goes, with `keptInstead`, the other attempt the user keeps (ADR-251).
   */
  remove(
    id: string,
    keepBranch: boolean,
    discardChanges: boolean,
    discardFingerprint?: string,
    keptInstead: string | null = null,
  ): Promise<EndedTaskFacts> {
    const task = this.#get(id);
    if (discardFingerprint !== undefined && !(keepBranch && discardChanges))
      throw new DomainError("bad_request", "a confirmed fingerprint goes only with discarding changes and keeping the branch");
    if (keptInstead !== null) this.#refuseUnlessOtherAttempt(task, keptInstead);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "ending it");
      const facts = await this.#whileRemoving(id, async () => {
        if (!discardChanges) await this.#refuseLoss(task, keepBranch);
        // The user's shell goes with the worktree, after the refusals the user answers (a running session, unsaved
        // changes): before the check for other processes, which would count it. So an end refused for a mise task or
        // service still running there has closed the shell. `#removing` refuses a new one meanwhile.
        await this.#deps.closeFolderTerminal(id);
        // Its reproduction check reads the worktree and runs on the task port in a copy beside it (ADR-227).
        await this.#deps.stopReproductionCheck(id);
        if (this.#deps.liveIn(task.worktree))
          throw new DomainError(
            "bad_request",
            `a process started by Trackwall still runs in the worktree of task ${task.branch}; stop it before ending the task`,
          );
        // Last before the deletion: after the shell, which could still write, is closed.
        if (discardFingerprint !== undefined) await this.#refuseChangedSince(task, discardFingerprint);
        const ending = {
          roundCommits: this.#deps.roundCommits(id),
          branchKept: keepBranch,
          keptInstead,
          endedAt: new Date(),
          conversation: await this.#conversationUse(task),
        };
        const ended = await endedTaskFacts(task, ending, this.#deps.vcs, this.#deps.log);
        await this.#discard(task, keepBranch);
        return ended;
      });
      this.#closeSessions(task);
      this.#save(this.#tasks.filter((t) => t.id !== id));
      if (task.javaNavigation) await this.#deps.javaNavigation.remove(task.id, `task ${task.id}`);
      return facts;
    });
  }

  /**
   * The attempt the user keeps when ending `task` from a comparison (ADR-251) must be another listed attempt at the same
   * task, one that goes on: the journal credits it with the choice.
   */
  #refuseUnlessOtherAttempt(task: KnownTask, kept: string): void {
    const other = this.#tasks.find((t) => t.id === kept);
    if (other === undefined || other.id === task.id || this.#removing.has(kept))
      throw new DomainError("bad_request", `the attempt to keep (${kept}) is not another task on the list`);
    if (firstAttempt(other, this.#tasks) !== firstAttempt(task, this.#tasks))
      throw new DomainError("bad_request", `task ${other.branch} is not another attempt at task ${task.branch}`);
  }

  /** What the task's conversation has used so far, for the draft of its merge request (ADR-238). */
  conversationUse(id: string): Promise<ConversationUse> {
    return this.#conversationUse(this.#get(id));
  }

  /**
   * What the task's conversation used (ADR-228): in a terminal under the task's id, in the conversation view under
   * Copilot CLI's id, unknown when its first start never learned it (ADR-137). A failed read is no usage, since ending
   * the task must not fail on its record, nor a merge request's draft on one line of it.
   */
  async #conversationUse(task: StoredTask): Promise<ConversationUse> {
    const conversation = task.view === "terminal" ? task.id : task.conversation;
    if (conversation === null) return NO_CONVERSATION_USE;
    try {
      return await this.#deps.conversationUse(conversation);
    } catch (err) {
      this.#deps.log(`reading the conversation of task ${task.id}: ${messageOf(err)}`);
      return NO_CONVERSATION_USE;
    }
  }

  /** A `job` that deletes the worktree only once git has stopped reading it; a new change computation meanwhile refuses. */
  async #whileRemoving<T>(id: string, job: () => Promise<T>): Promise<T> {
    this.#removing.add(id);
    try {
      await Promise.allSettled(this.#reading.get(id) ?? []);
      return await job();
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

  /**
   * The user confirmed deleting the work of a worktree with this fingerprint of its files and HEAD (ADR-210): work that
   * Trackwall can see came after (an edit, a commit outside the branch), or a folder git no longer knows as a worktree,
   * is refused. An editor outside Trackwall writing between this check and the deletion is not seen (§8).
   */
  async #refuseChangedSince(task: KnownTask, confirmed: string): Promise<void> {
    const pending = await asRepoUnavailable(task.branch, this.#deps.vcs.pendingWork(task));
    const current = pending.unregisteredDir
      ? null
      : await asRepoUnavailable(task.branch, this.#deps.vcs.discardFingerprint(task.worktree, task.base));
    if (current !== confirmed)
      throw new DomainError(
        "unsaved_changes",
        `the worktree of task ${task.branch} changed since what ending it deletes was confirmed; look at it again`,
      );
  }

  /** The worktree (with uncommitted and ignored files) and, without `keepBranch`, the branch. */
  async #discard(task: KnownTask, keepBranch: boolean): Promise<void> {
    await asRepoUnavailable(task.branch, this.#deps.vcs.removeWorktree(task.repoDir, task.worktree));
    if (!keepBranch) await asRepoUnavailable(task.branch, this.#deps.vcs.deleteBranch(task.repoDir, task.branch));
  }

  /** A failure to copy does not stop the task: the agent can still work, and the panel shows what is missing. */
  async #copyIncludedFiles(task: KnownTask): Promise<CopiedFiles> {
    try {
      return await this.#deps.vcs.copyIncludedFiles(task.repoDir, task.worktree);
    } catch (err) {
      this.#deps.log(`copying the included files of task ${task.id}: ${messageOf(err)}`);
      return { files: [], problems: [`copying failed: ${messageOf(err)}`], sha256: {} };
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

  /** The task's first session with its prompt (`new`), or one that goes on with its conversation (`resume`). */
  async #launch(task: KnownTask, start: "new" | "resume"): Promise<void> {
    // The model, the approvals mode and the sandbox on every start, the first and each resume: Copilot CLI would
    // otherwise resume on its default model, ask again and leave the sandbox (ADR-98, ADR-105, ADR-181).
    const sandboxArgs = task.sandbox ? [SANDBOX_ARG] : [];
    const place = {
      repo: task.repo,
      cwd: task.worktree,
      task: task.id,
      args: [...modelArgs(task.model), ...approvalArgs(task.approvals), ...sandboxArgs],
    };
    if (task.view === "terminal") {
      // `=` instead of a separate argument, so that a prompt starting with `-` is not a Copilot CLI option.
      const args = start === "new" ? [`--session-id=${task.id}`, `--interactive=${task.prompt}`] : [`--resume=${task.id}`];
      const lspServers = await this.#lspServers(task);
      await this.#deps.sessions.launch({
        ...place,
        view: "terminal",
        args: [...place.args, ...args],
        promptOnStart: start === "new",
        lspServers,
        conversation: task.id,
      });
      return;
    }
    // Only a hand-edited `tasks.json` gets here with Java navigation, which `#create` refuses in this view.
    if (task.javaNavigation) this.#deps.log(`task ${task.id} starts without Java navigation: it needs a terminal`);
    // A task whose first start never learned its conversation's id starts the conversation again from the prompt.
    const load = start === "resume" ? (task.conversation ?? undefined) : undefined;
    // A plan that waits for approval is written in Plan mode at every start, a resume and a restart included (ADR-229).
    const planMode = task.plan === "planning";
    const opening = planMode ? planFirstMessage(task.prompt) : task.prompt;
    const firstMessage = load === undefined ? opening : undefined;
    const conversation = await this.#deps.sessions.launch({ ...place, view: "conversation", load, firstMessage, planMode });
    if (conversation === undefined || conversation === task.conversation) return;
    // Saved at once: the next resume, even after a daemon crash, must load this conversation, not start another one.
    this.#save(this.#tasks.map((t) => (t.id === task.id ? { ...t, conversation } : t)));
  }

  /** jdtls for a task with Java navigation (ADR-99), on every start. */
  async #lspServers(task: KnownTask): Promise<Record<string, LspServer>> {
    if (!task.javaNavigation) return {};
    return this.#deps.javaNavigation.servers(task.id, task.worktree, `task ${task.id}`);
  }

  /** How the task's jdtls is doing (ADR-124), from its log; `null` for a task without Java navigation. */
  async javaNavigationStatus(id: string): Promise<JavaNavigationStatus | null> {
    const task = this.#get(id);
    if (!task.javaNavigation) return null;
    const running = this.#deps.sessions.of(task.id).find((s) => s.run.kind !== "exited");
    const startedAt = running === undefined ? null : new Date(running.startedAt);
    return this.#deps.javaNavigation.status(task.id, startedAt);
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
    if (this.#held.has(id)) throw new DomainError("bad_request", "this task is a part of a change whose sessions are still starting");
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
    return { ...task, worktree: taskWorktree(task.worktreesDir ?? this.#deps.legacyWorktreesDir, task.repo, task.branch) };
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

function view({
  repoDir: _,
  trustedMiseConfig: __,
  worktreesDir: ___,
  conversation: ____,
  handoff: _____,
  impactProposed: ______,
  stoppedAtTokenBudget: _______,
  ...task
}: KnownTask): Task {
  return task;
}

/** A git error in the repo or the task's worktree as `repo_unavailable` with git's message. */
function asRepoUnavailable<T>(label: string, work: Promise<T>): Promise<T> {
  return work.catch((err: unknown) => {
    throw new DomainError("repo_unavailable", `${label}: ${messageOf(err)}`);
  });
}

/** The folder of a task's reproduction check copy (ADR-227): beside its worktree, so it is in the same folders. */
function reproCopy(worktree: string): string {
  return `${worktree}.repro`;
}
