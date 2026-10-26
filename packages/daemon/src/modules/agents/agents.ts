import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTaskChanges,
  copilotMcpServers,
  type DialogAnswer,
  isSupervisor,
  type ReviewComment,
  type RunState,
  type SendMessageResult,
  type SendReviewResult,
  type Session,
  type SessionList,
  type SupervisorSettings,
  type Task,
  type TaskChanges,
  type TaskChangesSummary,
  type TaskMessage,
  type TaskMiseConfig,
  type TaskProposal,
  type TaskSharedFiles,
  type TaskUpdate,
  type ToolPermissions,
  type Verification,
} from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { findCopilot } from "./copilot-command.ts";
import type { CopilotHookEvent } from "./copilot-hook-record.ts";
import { type HookCommand, writeCopilotPlugin } from "./copilot-plugin.ts";
import { inboxPrompt } from "./inbox-prompt.ts";
import { LiveSession, type SessionPty, type SessionWindow } from "./live-session.ts";
import { proposedByOf, proposerKeyOf, SUPERVISOR } from "./proposer.ts";
import { type SessionRole, withInstructionsDir, writeSessionInstructions } from "./session-instructions.ts";
import { SessionTokens } from "./session-tokens.ts";
import { outcome, sessionWaitStatus, type WaitOutcome, waitUntilSettled } from "./session-wait.ts";
import { TaskCoordination } from "./task-coordination.ts";
import { TaskFile } from "./task-file.ts";
import { TaskProposals } from "./task-proposals.ts";
import { TaskReviews } from "./task-reviews.ts";
import { AgentTasks, type TasksVcs } from "./tasks.ts";
import type { ScreenViewer } from "./terminal-screen.ts";

/**
 * The `agents` module (§4.4, ADR-26): Copilot CLI sessions started from the UI in a repo from the projects folder, several
 * at once. Every session is Copilot CLI in a PTY owned by the daemon, in a process group of the `procs` module, with a
 * session plugin whose hooks report the state (ADR-17). The daemon builds the command; only a repo identifier comes from
 * outside (§1.2). Sessions live in daemon memory: the daemon's exit stops them together with the other process groups. A
 * session can belong to a task (ADR-31, `tasks.ts`): it then runs in the task's worktree, and the task outlives the
 * daemon. A session can also propose tasks, report the summary of its task and wait for another session (ADR-39): the
 * MCP server recognises it by its session token, and a task from a proposal starts only after the user approves it. One session, the
 * supervisor (ADR-58), runs in the projects folder instead of a repo, above all the others. A task's proposer sends its
 * session messages and hears about its work through updates (ADR-68, `task-coordination.ts`).
 */

/** The PTY size before a session terminal reports its own. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;
/** How often sessions read hook records and check for the end of the process. */
const TICK_MS = 200;
/**
 * The session's MCP configuration in the session directory; a file instead of JSON in an argument, so that JSON's quotes
 * do not depend on argument quoting on Windows.
 */
const MCP_CONFIG_FILE = "mcp-config.json";
/** The session token in the session directory, which the session's stdio bridge reads and sends to the MCP server (ADR-39). */
const SESSION_TOKEN_FILENAME = "session-token";
/** The hook records the session plugin's hook processes append to (`HookTail` reads them). */
const HOOKS_FILENAME = "hooks.jsonl";
const SESSIONS_DIR = "sessions";
const TASKS_FILE = "tasks.json";
const WORKTREES_DIR = "worktrees";

/** A session's directory in the state directory: its plugin, MCP configuration, token and hook records. */
function sessionDir(home: string, id: string): string {
  return join(home, SESSIONS_DIR, id);
}

/** A session's token file, which its stdio bridge reads (ADR-39). */
export function sessionTokenFile(home: string, id: string): string {
  return join(sessionDir(home, id), SESSION_TOKEN_FILENAME);
}

/** A session's `hooks.jsonl`. */
export function sessionHooksFile(home: string, id: string): string {
  return join(sessionDir(home, id), HOOKS_FILENAME);
}

/** What `agents` needs from `procs`; wired in the facade. */
interface AgentsProcs {
  startTerminal(spec: {
    owner: string;
    command: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
    onData: (bytes: Uint8Array) => void;
  }): Promise<{ run: RunState; terminal: SessionPty }>;
  state(owner: string): RunState | undefined;
  stop(owner: string): Promise<RunState | undefined>;
  liveIn(dir: string): boolean;
}

/**
 * What `agents` needs from `workspace`: a repo root by its id (`not_found` without such a repo), the projects folder
 * the supervisor runs in (`bad_request` while it is not set), the tool permissions a session starts with and the
 * supervisor settings.
 */
interface AgentsRepos {
  repoPath(id: string): Promise<string>;
  projectsDir(): Promise<string>;
  /** The `toolPermissions` patterns for a session in repo `repo` (`null` for the supervisor), ADR-66. */
  toolPermissions(repo: string | null): ToolPermissions;
  /** `supervisor` from `workspace.yaml` (ADR-78); `invalid_config` for a bad key. */
  supervisorSettings(): SupervisorSettings;
  /** Moves the repo out of the projects folder (ADR-83) and returns where it went. */
  /**
   * Moves repo `id` out of the projects folder (ADR-83) while its folder is still `expectedDir`; `beforeMove` runs right
   * before the move, with nothing awaited in between, so a check in it still holds when the folder moves.
   */
  removeRepo(id: string, expectedDir: string, beforeMove: () => void): Promise<string>;
}

export interface AgentsDeps {
  procs: AgentsProcs;
  repos: AgentsRepos;
  /** Task worktrees and branches (ADR-31). */
  vcs: TasksVcs;
  /**
   * The daemon's state directory; sessions keep their files in `sessions/<session>/`, tasks keep their list in `tasks.json`
   * and their worktrees in `worktrees/<repo>/`.
   */
  home: string;
  /**
   * The Copilot CLI program (a name from `PATH` or a full path) with arguments before the session's arguments;
   * `["copilot"]` in the daemon.
   */
  copilot: readonly string[];
  /** The daemon's version, which every session learns from its session instructions. */
  version: string;
  /** The environment of user processes (`PATH` from the login shell on macOS). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** The session plugin's hook program for an event: the daemon with the `copilot-hook` subcommand (without `cwd`, the module sets it). */
  hookCommand: (event: CopilotHookEvent, hooksFile: string) => Omit<HookCommand, "cwd">;
  /**
   * The stdio bridge to the daemon's MCP server (§5.3) with the session token file (ADR-39): every session gets the
   * `trackwall` server through `--additional-mcp-config`, and the server knows from the token which session is calling.
   */
  sessionMcpCommand: (tokenFile: string) => readonly string[];
  /** Opens a directory in VS Code (a task's worktree). */
  openEditor: (dir: string) => void;
  log: (msg: string) => void;
}

/** What `wait_for_session` waits for: a session or a task (also a proposal that is about to become a task). */
export type WaitTarget = { session: string } | { task: string };

export class Agents {
  readonly #deps: AgentsDeps;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #tokens = new SessionTokens();
  readonly #tasks: AgentTasks;
  readonly #proposals = new TaskProposals();
  /** The folder each waiting repo removal names, fixed when it was proposed: approval moves that folder or none (ADR-83). */
  readonly #removalDirs = new Map<string, string>();
  readonly #reviews = new TaskReviews();
  readonly #coordination: TaskCoordination;
  readonly #worktreesDir: string;
  /** The supervisor start under way, so that two requests at once start one supervisor, not two (ADR-58). */
  #supervisorStart: Promise<Session> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: AgentsDeps) {
    this.#deps = deps;
    const worktreesDir = join(deps.home, WORKTREES_DIR);
    this.#worktreesDir = worktreesDir;
    this.#tasks = new AgentTasks({
      vcs: deps.vcs,
      repos: deps.repos,
      file: new TaskFile(join(deps.home, TASKS_FILE), deps.log),
      liveIn: (dir) => deps.procs.liveIn(dir),
      worktreesDir,
      openEditor: deps.openEditor,
      log: deps.log,
      sessions: {
        launch: (spec) => this.#launch(spec),
        of: (task) => this.#views().filter((s) => s.task === task),
        close: (id) => this.#close(id),
      },
    });
    this.#coordination = new TaskCoordination({
      task: (id) => this.task(id),
      findTask: (id) => this.findTask(id),
      proposedBy: (id) => proposedByOf(this.session(id)),
      proposerKey: (id) => proposerKeyOf(this.session(id)),
      runningOfTask: (task) => this.#runningOfTask(task),
      runningProposer: (proposer) => [...this.#sessions.values()].find((s) => proposerKeyOf(s) === proposer && this.#isRunning(s)),
      hasProposer: (proposer) => proposer === SUPERVISOR || this.#sessions.has(proposer),
      log: deps.log,
    });
  }

  sessions(): SessionList {
    const tasks = this.#tasks.list();
    // A proposal being approved that is already a task is only a task: the UI and `list_sessions` see one object.
    const proposals = this.#proposals.list().filter((p) => !tasks.some((t) => t.id === p.id));
    return { sessions: this.#views(), tasks, proposals, messages: this.#coordination.messages(), worktreesDir: this.#worktreesDir };
  }

  /** One listed session (`not_found` when it does not exist or the user closed it). */
  session(id: string): Session {
    return this.#view(this.#get(id));
  }

  async start(repo: string): Promise<Session> {
    return this.#launch({ repo, cwd: await this.#deps.repos.repoPath(repo), task: null, args: [], promptOnStart: false });
  }

  /**
   * The supervisor (ADR-58): Copilot CLI in the projects folder, above the sessions of all repos. At most one runs at a
   * time: while one is starting or runs, this returns it. A new one replaces the ended ones, which are closed once it
   * has started, so a failed start keeps the last screen; the work they delegated stays, marked as the supervisor's
   * (`ProposedBy.supervisor`).
   */
  async startSupervisor(): Promise<Session> {
    if (this.#supervisorStart) return this.#supervisorStart;
    const running = this.#runningSupervisor();
    if (running) return running;
    return this.#startNewSupervisor(null);
  }

  /**
   * A new supervisor with `firstMessage` as its first message (`--interactive`), so it works from the start: the day start
   * (ADR-70). While a supervisor starts or runs, `bad_request`: the user stops it first, so no conversation ends without them.
   */
  async startSupervisorWith(firstMessage: string): Promise<Session> {
    this.assertNoSupervisor();
    return this.#startNewSupervisor(firstMessage);
  }

  /** `bad_request` while a supervisor starts or runs (ADR-70). */
  assertNoSupervisor(): void {
    if (this.#supervisorStart || this.#runningSupervisor())
      throw new DomainError("bad_request", "the supervisor is running; stop it to start your day with a new one");
  }

  #runningSupervisor(): Session | undefined {
    return this.#views().find((s) => isSupervisor(s) && s.run.kind !== "exited");
  }

  /** `firstMessage` is the first message (`--interactive`) of the new supervisor; `null` for none. */
  #startNewSupervisor(firstMessage: string | null): Promise<Session> {
    this.#supervisorStart = this.#replaceSupervisor(firstMessage).finally(() => {
      this.#supervisorStart = undefined;
    });
    return this.#supervisorStart;
  }

  async #replaceSupervisor(firstMessage: string | null): Promise<Session> {
    const ended = this.#views().filter(isSupervisor);
    const cwd = await this.#deps.repos.projectsDir();
    const args = firstMessage === null ? [] : [`--interactive=${firstMessage}`];
    const started = await this.#launch({ repo: null, cwd, task: null, args, promptOnStart: firstMessage !== null });
    // One of them may have been dismissed during the start; the start has still succeeded.
    for (const old of ended) if (this.#sessions.has(old.id)) this.#close(old.id);
    return started;
  }

  /** The session whose session token came from the stdio bridge; `undefined` for an unknown token. */
  callerSession(token: string): string | undefined {
    return this.#tokens.session(token);
  }

  /** A task proposal from session `caller` (`null`: an agent outside Trackwall) in a repo from the projects folder (ADR-39). */
  async propose(caller: string | null, proposal: { repo: string; title: string; prompt: string }): Promise<TaskProposal> {
    await this.#deps.repos.repoPath(proposal.repo);
    return this.#proposals.add({ kind: "task", ...proposal, proposedBy: proposedByOf(caller === null ? null : this.session(caller)) });
  }

  /** A proposal to remove a repo from the projects folder (ADR-83), from session `caller` like a task proposal. */
  async proposeRepoRemoval(caller: string | null, repo: string, reason: string): Promise<TaskProposal> {
    const session = caller === null ? null : this.session(caller);
    if (session?.task != null)
      throw new DomainError(
        "bad_request",
        "a task session works in its worktree and proposes no folder actions; tell your proposer instead",
      );
    const repoDir = await this.#deps.repos.repoPath(repo);
    const proposal = this.#proposals.add({
      kind: "remove_repo",
      repo,
      title: `Remove ${repo} from the projects folder`,
      prompt: reason,
      proposedBy: proposedByOf(session),
    });
    this.#removalDirs.set(proposal.id, repoDir);
    return proposal;
  }

  /**
   * A task from a proposal, with the prompt edited by the user. The proposal stays on the list until there is a task with
   * its identifier, but a second approval is `not_found`; it waits for a decision again when the task was not created. A
   * task left behind by a failed cleanup is ended by the user, so the proposal then disappears.
   */
  async approveProposal(id: string, prompt: string): Promise<Task> {
    if (this.#proposals.get(id).kind !== "task") throw new DomainError("bad_request", `proposal ${id} is not a task`);
    const { repo, title, proposedBy } = this.#proposals.take(id);
    try {
      return await this.#tasks.create(repo, prompt, { id, title, proposedBy });
    } finally {
      this.#proposals.release(id, this.#tasks.find(id) === undefined);
    }
  }

  /**
   * The user approves removing a repo (ADR-83). Refused while anything of the repo would lose its folder: a session in
   * it, a task (its worktree belongs to the repo's git directory) or a process started there. A refusal leaves the
   * proposal waiting, so the user ends those and approves again. The other proposals for the repo are rejected with it,
   * since they could no longer start.
   */
  async approveRepoRemoval(id: string): Promise<void> {
    const proposal = this.#proposals.get(id);
    const repoDir = this.#removalDirs.get(id);
    if (proposal.kind !== "remove_repo" || repoDir === undefined)
      throw new DomainError("bad_request", `proposal ${id} is not a repo removal`);
    if (this.#proposals.list().some((p) => p.repo === proposal.repo && this.#proposals.approving(p.id)))
      throw new DomainError("bad_request", `${proposal.repo} is already being removed or a task of it started`);
    this.#assertNothingRunsIn(proposal.repo, repoDir);
    this.#proposals.take(id);
    let movedTo: string;
    try {
      movedTo = await this.#deps.repos.removeRepo(proposal.repo, repoDir, () => this.#assertNothingRunsIn(proposal.repo, repoDir));
    } catch (err) {
      this.#proposals.release(id, true);
      throw err;
    }
    this.#proposals.release(id, false);
    this.#removalDirs.delete(id);
    this.#coordination.repoRemoved(proposal, movedTo);
    for (const other of this.#proposals.list())
      if (other.repo === proposal.repo && this.#proposals.find(other.id))
        this.rejectProposal(other.id, `${proposal.repo} was removed from the projects folder`);
  }

  #assertNothingRunsIn(repo: string, repoDir: string): void {
    const sessions = this.#views().filter((s) => s.repo === repo && s.task === null && s.run.kind !== "exited");
    if (sessions.length > 0) throw new DomainError("bad_request", `stop the sessions in ${repo} first (${sessions.length} running)`);
    if (this.#tasks.creatingIn(repo)) throw new DomainError("bad_request", `a task of ${repo} is being created; wait for it, then end it`);
    const tasks = this.#tasks.list().filter((t) => t.repo === repo);
    if (tasks.length > 0)
      throw new DomainError("bad_request", `end the tasks of ${repo} first (${tasks.length}): their worktrees belong to the repo`);
    if (this.#deps.procs.liveIn(repoDir)) throw new DomainError("bad_request", `stop the mise tasks and services running in ${repo} first`);
  }

  rejectProposal(id: string, reason: string | undefined): void {
    const proposal = this.#proposals.get(id);
    this.#proposals.reject(id, reason ?? null);
    this.#removalDirs.delete(id);
    this.#coordination.proposalRejected(proposal, reason ?? null);
  }

  /** A summary from session `caller` for its own task (`report_result`); it goes to the task's proposer too (ADR-68). */
  reportSummary(caller: string | null, text: string): Task {
    const task = caller === null ? null : this.session(caller).task;
    if (caller === null || task === null)
      throw new DomainError("bad_request", "only a session that runs a task in Trackwall can report a result");
    const reported = this.#tasks.setSummary(task, text);
    this.#coordination.resultReported(reported, caller);
    return reported;
  }

  /**
   * The user's review of a task's changes (ADR-62): queued for the task's agent, and the task's running session is asked
   * to read it, now or once it waits for input; without one, the session the user resumes is asked.
   */
  sendReview(id: string, comments: readonly ReviewComment[]): SendReviewResult {
    // Only to refuse an unknown or ended task (`not_found`).
    this.#tasks.task(id);
    const unread = this.#reviews.add(id, comments);
    this.#coordination.reviewed(id);
    const running = this.#runningOfTask(id);
    return { unread, delivery: running ? running.askToRead() : "on_resume" };
  }

  /** The prompt for what waits unread for a session: its task's review comments and messages, and its updates. */
  #inboxPrompt(session: { id: string; repo: string | null; task: string | null }): string | undefined {
    const reviewComments = session.task === null ? 0 : this.#reviews.unread(session.task);
    return inboxPrompt({ reviewComments, ...this.#coordination.unread(session) });
  }

  /** The unread review comments of session `caller`'s own task (`get_review_comments`), which now count as read. */
  takeReviewComments(caller: string | null): ReviewComment[] {
    const task = caller === null ? null : this.session(caller).task;
    if (task === null) throw new DomainError("bad_request", "only a session that runs a task in Trackwall has review comments");
    return this.#reviews.take(task);
  }

  /**
   * A message from session `caller` to the session of a task it proposed (`send_message`, ADR-68); the task's agent
   * reads it with `get_messages`.
   */
  sendMessage(caller: string | null, task: string, text: string): SendMessageResult {
    return this.#coordination.send(caller, task, text);
  }

  /** The unread messages to session `caller`'s own task (`get_messages`), which now count as read. */
  takeMessages(caller: string | null): TaskMessage[] {
    const task = caller === null ? null : this.session(caller).task;
    if (task === null) throw new DomainError("bad_request", "only a session that runs a task in Trackwall gets messages");
    return this.#coordination.takeMessages(task);
  }

  /** The unread updates on the work session `caller` delegated (`get_updates`), which now count as read. */
  takeUpdates(caller: string | null): { updates: TaskUpdate[]; dropped: number } {
    return this.#coordination.takeUpdates(caller);
  }

  /** A task's verification has its verdict (ADR-64), which goes to the task's proposer (ADR-68). */
  verificationFinished(verification: Verification): void {
    this.#coordination.verificationFinished(verification);
  }

  /** Waits until a session or task needs someone, at most `timeoutMs`; a session cannot wait for itself. */
  waitFor(caller: string | null, target: WaitTarget, timeoutMs: number, signal: AbortSignal): Promise<WaitOutcome> {
    const first = this.#waitOutcome(target);
    if (caller !== null && first.session?.id === caller) throw new DomainError("bad_request", "a session cannot wait for itself");
    return waitUntilSettled(() => this.#waitOutcome(target), timeoutMs, signal);
  }

  #waitOutcome(target: WaitTarget): WaitOutcome {
    if ("session" in target) {
      const session = this.session(target.session);
      return outcome(sessionWaitStatus(session), { task: session.task === null ? null : this.task(session.task), session });
    }
    const task = this.#tasks.find(target.task);
    if (task) {
      const session = this.#views().find((s) => s.task === task.id) ?? null;
      const status = session ? sessionWaitStatus(session) : this.#tasks.busy(task.id) ? "starting" : "no_session";
      return outcome(status, { task, session });
    }
    const approving = this.#proposals.approving(target.task);
    if (approving) return outcome("starting", { proposal: approving });
    const proposal = this.#proposals.find(target.task);
    if (proposal) return outcome("proposal_pending", { proposal });
    const rejection = this.#proposals.rejection(target.task);
    if (rejection) return outcome("proposal_rejected", { rejectionReason: rejection.reason });
    throw new DomainError("not_found", `no task or task proposal ${target.task}`);
  }

  createTask(repo: string, prompt: string): Promise<Task> {
    return this.#tasks.create(repo, prompt, { id: randomUUID(), title: null, proposedBy: null });
  }

  resumeTask(id: string): Promise<Task> {
    return this.#tasks.resume(id);
  }

  /** A task by identifier (`not_found` when it does not exist or the user ended it). */
  task(id: string): Task {
    return this.#tasks.task(id);
  }

  /** A task, or `undefined` when there is no such task (unknown or ended). */
  findTask(id: string): Task | undefined {
    return this.#tasks.find(id);
  }

  /**
   * A task named next to a repo, which must belong to it: `not_found` for an unknown or ended task, `bad_request` for a
   * task of another repo. Without `repo`, any task.
   */
  taskOfRepo(id: string, repo: string | undefined): Task {
    const task = this.#tasks.task(id);
    if (repo !== undefined && task.repo !== repo) throw new DomainError("bad_request", `task ${id} is in ${task.repo}, not in ${repo}`);
    return task;
  }

  taskChanges(id: string): Promise<TaskChanges> {
    return this.#tasks.changes(id);
  }

  /** Other tasks of the same repo that change the same files (ADR-44). */
  taskSharedFiles(id: string): Promise<TaskSharedFiles[]> {
    return this.#tasks.sharedFiles(id);
  }

  /** A task's changes without the diff, for an agent (the MCP tool `get_session`). */
  taskChangesSummary(id: string): Promise<TaskChangesSummary> {
    return this.#tasks.summary(id);
  }

  /** A task's changes with their diff for an agent (MCP tool `get_task_changes`), under `paths`, the diff cut within `maxPatchBytes`. */
  agentTaskChanges(id: string, maxPatchBytes: number, paths: readonly string[]): Promise<AgentTaskChanges> {
    return this.#tasks.agentChanges(id, maxPatchBytes, paths);
  }

  openTaskEditor(id: string): void {
    this.#tasks.openEditor(id);
  }

  /** The task worktree's mise config against the one the user trusted (ADR-59). */
  taskMiseConfig(id: string): Promise<TaskMiseConfig> {
    return this.#tasks.miseConfig(id);
  }

  /** The user trusts the worktree's mise config they saw (`digest`), only from the UI (ADR-59). */
  trustTaskMiseConfig(id: string, digest: string): Promise<TaskMiseConfig> {
    return this.#tasks.trustMiseConfig(id, digest);
  }

  /**
   * The worktree a mise task of the task runs in, while its mise config is the trusted one, and the task port its runs
   * get; for the `mise` module (ADR-59, ADR-61).
   */
  trustedTaskWorktree(id: string, repo: string): Promise<{ worktree: string; port: number }> {
    return this.#tasks.trustedWorktree(id, repo);
  }

  async removeTask(id: string, keepBranch: boolean, discardChanges: boolean): Promise<void> {
    await this.#tasks.remove(id, keepBranch, discardChanges);
    this.#reviews.take(id);
    this.#coordination.taskEnded(id);
  }

  /**
   * Copilot CLI in `cwd` (the repo root or the worktree of task `task`) with arguments before the session's arguments;
   * `promptOnStart` when the arguments carry the first message (`--interactive`), so the session works from the start.
   */
  async #launch({ repo, cwd, task, args, promptOnStart }: LaunchSpec): Promise<Session> {
    const env = { ...(await this.#deps.env()), TERM: "xterm-256color", COLORTERM: "truecolor" };
    const [name = "copilot", ...prefix] = this.#deps.copilot;
    const program = findCopilot(name, env);
    if (!program) throw new DomainError("agent_unavailable", `Copilot CLI (${name}) not found in PATH`);
    const permissions = this.#deps.repos.toolPermissions(repo);
    const role: SessionRole = repo === null ? { repo, changesCode: this.#deps.repos.supervisorSettings().changesCode } : { repo, task };
    const id = randomUUID();
    const dir = sessionDir(this.#deps.home, id);
    const token = this.#tokens.issue(id);
    let prepared: PreparedSession;
    try {
      prepared = this.#prepare({ id, role, task, dir, token, promptOnStart, program });
    } catch (err) {
      this.#tokens.revoke(id);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const { session, instructionsDir } = prepared;
    try {
      const { terminal } = await this.#deps.procs.startTerminal({
        owner: owner(id),
        command: [
          program,
          ...prefix,
          "--plugin-dir",
          join(dir, "plugin"),
          "--additional-mcp-config",
          `@${join(dir, MCP_CONFIG_FILE)}`,
          ...toolPermissionArgs(permissions),
          ...args,
        ],
        cwd,
        env: instructionsDir === null ? env : withInstructionsDir(env, instructionsDir),
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        onData: (bytes) => session.output(bytes),
      });
      session.connect(terminal);
    } catch (err) {
      this.#tokens.revoke(id);
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
      throw domainError(repo, err);
    }
    this.#sessions.set(id, session);
    // A review or a message sent while the task had no running session (ADR-62, ADR-68); the prompt names only what is
    // unread, and nothing is typed when nothing is. Not the updates of a new supervisor or main session: the user starts
    // those to talk, and the next update asks them anyway.
    if (task !== null) session.askToRead();
    this.#startTicking();
    return this.#view(session);
  }

  async stop(id: string): Promise<Session> {
    const session = this.#get(id);
    await this.#deps.procs.stop(owner(id));
    return this.#view(session);
  }

  /** Answers a running session's approval from outside its terminal (ADR-66); see `LiveSession.answerDialog`. */
  answerDialog(id: string, dialog: string, answer: DialogAnswer): Session {
    const session = this.#get(id);
    // The state after the hooks already written, so that an approval just answered in the terminal is not answered again.
    if (this.#fresh(session)?.run.kind !== "running") throw new DomainError("dialog_changed", "the session is no longer running");
    session.answerDialog(dialog, answer);
    return this.#view(session);
  }

  /** Closes an ended session: it disappears from the list, and its files from the state directory. The session's task stays. */
  dismiss(id: string): SessionList {
    this.#close(id);
    return this.sessions();
  }

  /** A session terminal: first the screen image, then live output, and `onClosed` when the session disappears. */
  attach(id: string, viewer: ScreenViewer, onSnapshot: (snapshot: string) => void, onClosed: () => void): SessionWindow {
    return this.#get(id).attach(viewer, onSnapshot, onClosed);
  }

  /** Daemon start: session files from the previous run (sessions do not outlive the daemon). */
  sweepLeftovers(): void {
    try {
      rmSync(join(this.#deps.home, SESSIONS_DIR), { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`cleaning up the session directory: ${String(err)}`);
    }
  }

  /** Daemon exit: `procs.stopAll` stops the processes, here only the observing ends. */
  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #close(id: string): void {
    const session = this.#get(id);
    if (this.#deps.procs.state(owner(id))?.kind !== "exited") {
      throw new DomainError("bad_request", "the session is still running; stop it before closing");
    }
    this.#sessions.delete(id);
    this.#tokens.revoke(id);
    this.#coordination.sessionClosed(session);
    session.dispose();
    this.#removeDir(id);
  }

  /** Sessions, newest first. */
  #views(): Session[] {
    return [...this.#sessions.values()].flatMap((s) => this.#fresh(s) ?? []).reverse();
  }

  /**
   * The session directory with the session plugin, MCP config, session token, session instructions and an empty
   * `hooks.jsonl`, before Copilot CLI starts.
   */
  #prepare({ id, role, task, dir, token, promptOnStart, program }: SessionFiles): PreparedSession {
    const { repo } = role;
    const pluginDir = join(dir, "plugin");
    const hooksFile = join(dir, HOOKS_FILENAME);
    const tokenFile = join(dir, SESSION_TOKEN_FILENAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(hooksFile, "");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const mcpConfig = copilotMcpServers(this.#deps.sessionMcpCommand(tokenFile));
    writeFileSync(join(dir, MCP_CONFIG_FILE), JSON.stringify(mcpConfig, null, 2));
    writeCopilotPlugin(pluginDir, (event) => ({ ...this.#deps.hookCommand(event, hooksFile), cwd: pluginDir }));
    const instructionsDir = writeSessionInstructions(dir, this.#deps.version, role);
    if (instructionsDir === null)
      this.#deps.log(`session ${id} starts without Trackwall instructions: the session directory path has a comma`);
    const session = new LiveSession({
      id,
      repo,
      task,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      hooksFile,
      promptOnStart,
      program,
      run: () => this.#deps.procs.state(owner(id)),
      prompt: () => this.#inboxPrompt({ id, repo, task }),
      onUserText: () => this.#coordination.userTyped({ id, task }),
      onEvent: (event) => {
        // The session reads its hooks inside the user's key or another session's call: news for the proposer must not fail them.
        try {
          this.#coordination.sessionEvent({ id, task }, event);
        } catch (err) {
          this.#deps.log(`session ${id}: telling the proposer: ${String(err)}`);
        }
      },
    });
    return { session, instructionsDir };
  }

  #startTicking(): void {
    this.#timer ??= setInterval(() => this.#tick(), TICK_MS);
    this.#timer.unref();
  }

  #tick(): void {
    let live = 0;
    for (const session of this.#sessions.values()) {
      try {
        if (session.tick()) live++;
      } catch (err) {
        live++;
        this.#deps.log(`session ${session.id}: ${String(err)}`);
      }
    }
    if (live === 0) this.close();
  }

  /** The task's newest session while it runs. */
  #runningOfTask(task: string): LiveSession | undefined {
    return [...this.#sessions.values()].reverse().find((s) => s.task === task && this.#isRunning(s));
  }

  /** The state after the hooks already written, as `#fresh` reads it. */
  #isRunning(session: LiveSession): boolean {
    return this.#fresh(session)?.run.kind === "running";
  }

  #get(id: string): LiveSession {
    const session = this.#sessions.get(id);
    if (!session) throw new DomainError("not_found", `no session ${id}`);
    return session;
  }

  /** The session's state after reading new hook records and the end of the process. */
  #fresh(session: LiveSession): Session | undefined {
    session.tick();
    return session.view();
  }

  #view(session: LiveSession): Session {
    const view = this.#fresh(session);
    if (!view) throw new Error(`session ${session.id} has no process group`);
    return view;
  }

  #removeDir(id: string): void {
    try {
      rmSync(sessionDir(this.#deps.home, id), { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`removing session files ${id}: ${String(err)}`);
    }
  }
}

/** What `#launch` starts: Copilot CLI in a repo root, in a task's worktree, or the supervisor in the projects folder. */
interface LaunchSpec {
  /** `null` for the supervisor. */
  repo: string | null;
  cwd: string;
  task: string | null;
  args: readonly string[];
  promptOnStart: boolean;
}

/** The directory of a new session and what follows from it for `LiveSession`. */
interface SessionFiles {
  id: string;
  role: SessionRole;
  task: string | null;
  dir: string;
  token: string;
  promptOnStart: boolean;
  /** The Copilot CLI program the session starts. */
  program: string;
}

/** A prepared session directory: the session and its instructions directory (`null` when it could not be written). */
interface PreparedSession {
  session: LiveSession;
  instructionsDir: string | null;
}

/** Copilot CLI's own approval rules (ADR-66); one argument each, with `=`, so a pattern never reads as another option. */
function toolPermissionArgs(permissions: ToolPermissions): string[] {
  return [...permissions.allow.map((p) => `--allow-tool=${p}`), ...permissions.deny.map((p) => `--deny-tool=${p}`)];
}

/** The group owner key in `procs`; only ever built, never taken apart again. */
function owner(id: string): string {
  return `agent:${id}`;
}

function domainError(repo: string | null, err: unknown): unknown {
  if (!(err instanceof SpawnFailure)) return err;
  const place = repo ?? "the projects folder";
  return new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "agent_unavailable", `${place}: ${err.message}`);
}
