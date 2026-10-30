import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTaskChanges,
  type DialogAnswer,
  type EnvironmentCheck,
  type HttpEndpoint,
  isSupervisor,
  type JavaNavigationSettings,
  type JavaNavigationStatus,
  type MiseTarget,
  type ReviewComment,
  type SendMessageResult,
  type SendReviewResult,
  type Session,
  type SessionList,
  type SessionView,
  type StartOptions,
  type SupervisorConversation,
  type SupervisorSettings,
  type Task,
  type TaskApprovals,
  type TaskChanges,
  type TaskChangesSummary,
  type TaskHandoffState,
  type TaskMessage,
  type TaskMiseConfig,
  type TaskProposal,
  type TaskSharedFiles,
  type TaskUpdate,
  type ToolPermissions,
  type Verification,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { AcpSession, type ConversationViewer, type ConversationWindow } from "./acp-session.ts";
import { AgentQueuesFile } from "./agent-queues.ts";
import type { AgentSession } from "./agent-session.ts";
import type { CopilotHookOutput } from "./copilot-hook-output.ts";
import { CopilotHookEvent } from "./copilot-hook-record.ts";
import { HandoffWatch } from "./handoff-watch.ts";
import { appendHookRecord } from "./hook-tail.ts";
import { inboxPrompt } from "./inbox-prompt.ts";
import { javaNavigationState } from "./java-language-server.ts";
import { LAST_SUPERVISOR_FILE, LastSupervisorFile } from "./last-supervisor.ts";
import { ListedSessions, resumableOf } from "./listed-sessions.ts";
import { LiveSession, type SessionEvent, type SessionWindow } from "./live-session.ts";
import { MiseTrustNotices, type TrustRecipient, trustRecipientOf } from "./mise-trust-notices.ts";
import { proposedByOf, proposerExists, proposerKeyOf, proposerKind, proposerOf } from "./proposer.ts";
import { type ResumableSession, ResumableSessions, resumablePlace, type SessionLaunch, sessionLaunch } from "./resumable-sessions.ts";
import type { SessionMiseEnv } from "./session-env.ts";
import {
  type LauncherProcs,
  type SessionCallbacks,
  SessionLauncher,
  type SessionPlace,
  type StartedSession,
  sessionHooksFile,
  sessionOwner,
  sessionsDir,
  type TerminalLaunch,
} from "./session-launcher.ts";
import { SessionTokens } from "./session-tokens.ts";
import { outcome, sessionWaitStatus, type WaitOutcome, waitUntilSettled } from "./session-wait.ts";
import { SupervisorSessions } from "./supervisor-sessions.ts";
import { TaskCoordination } from "./task-coordination.ts";
import { TaskFile } from "./task-file.ts";
import { TaskProposals } from "./task-proposals.ts";
import { TaskReviews } from "./task-reviews.ts";
import { AgentTasks, type TaskLaunch, type TaskOptions, type TasksVcs } from "./tasks.ts";
import type { ScreenViewer } from "./terminal-screen.ts";

/**
 * The `agents` module (§4.4, ADR-26): Copilot CLI sessions started from the UI in a repo from the projects folder,
 * several at once. A session is Copilot CLI in a process group of the `procs` module, either in a PTY owned by the
 * daemon with a session plugin whose hooks report the state (ADR-17), or over ACP in the conversation view (ADR-107).
 * The daemon builds the command; only a repo identifier comes from outside (§1.2); how a session starts is
 * `session-launcher.ts`, and the list of sessions `listed-sessions.ts`. Sessions live in daemon memory: the daemon's
 * exit stops them together with the other process groups. A session can belong to a task (ADR-31, `tasks.ts`): it then
 * runs in the task's worktree, and the task outlives the daemon. A session can also propose tasks, report the summary
 * of its task and wait for another session (ADR-39): the MCP server recognises it by its session token, and a task from
 * a proposal starts only after the user approves it. One session, the supervisor (ADR-58, `supervisor-sessions.ts`),
 * runs in the projects folder instead of a repo, above all the others. A task's proposer sends its session messages and
 * hears about its work through updates (ADR-68, `task-coordination.ts`).
 */

export const TASKS_FILE = "tasks.json";
/** The sessions that run, for the next daemon to resume (ADR-95). */
export const RESUMABLE_SESSIONS_FILE = "resumable-sessions.json";
export { LAST_SUPERVISOR_FILE } from "./last-supervisor.ts";
/** Proposals, reviews, messages and updates that wait, for the next daemon (ADR-115). */
export const AGENT_QUEUES_FILE = "agent-queues.json";
/** Where task worktrees went before ADR-84; tasks from then keep them there until they end. */
export const LEGACY_WORKTREES_DIR = "worktrees";

/** What `agents` needs from `procs`; wired in the facade. */
interface AgentsProcs extends LauncherProcs {
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
  /** The task worktrees folder for a new task (ADR-84), made when it is the default one in `.trackwall` (ADR-125). */
  newTaskWorktreesDir(): Promise<string>;
  /** The `toolPermissions` patterns for a session in repo `repo` (`null` in the projects folder) or the supervisor, ADR-66. */
  toolPermissions(session: Pick<Session, "repo" | "supervisor">): ToolPermissions;
  /** `supervisor` from `workspace.yaml` (ADR-78); `invalid_config` for a bad key. */
  supervisorSettings(): SupervisorSettings;
  /** `agentSecrets` from `workspace.yaml` (ADR-93): the secrets from mise a session's tools get; `invalid_config` for a bad key. */
  agentSecrets(): readonly string[];
  /** `javaNavigation` from `workspace.yaml` (ADR-99): the Java language server for tasks; `null` without the key. */
  javaNavigation(): JavaNavigationSettings | null;
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
   * The daemon's state directory; sessions keep their files in `sessions/<session>/` and tasks their list in `tasks.json`
   * (worktrees saved before ADR-84 are in `worktrees/<repo>/`, newer ones in the task worktrees folder of `workspace`).
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
  /** What mise sets for a session in its place (ADR-93); a refused place is its `problem`, not a failed start. */
  miseEnv: (place: { repo: string | null; task: string | null }) => Promise<SessionMiseEnv>;
  /**
   * Where the session plugin's hook for an event POSTs its payload (ADR-88): the daemon's hook route with the session
   * token alone (ADR-138), which `authenticate` in `api/server.ts` resolves to the session `receiveHook` takes; the API's
   * port is known only once it listens.
   */
  sessionHook: (event: CopilotHookEvent, sessionToken: string) => HttpEndpoint;
  /**
   * The daemon's MCP server (§5.3) over HTTP with the session token alone (ADR-39, ADR-89, ADR-138): every
   * session gets the `trackwall` server through `--additional-mcp-config`, and the server knows from the token which
   * session is calling.
   */
  sessionMcpServer: (sessionToken: string) => HttpEndpoint;
  /** Opens a directory in VS Code (a task's worktree). */
  openEditor: (dir: string) => void;
  /** Whether a board item is on the board (ADR-133): a task or a proposal names only an existing one. */
  boardHas: (item: string) => Promise<boolean>;
  /** A task has ended and its worktree is gone: what other modules keep of it (its logs, ADR-59) can go too. */
  onTaskRemoved: (task: string) => void;
  log: (msg: string) => void;
}

/** What `wait_for_session` waits for: a session or a task (also a proposal that is about to become a task). */
export type WaitTarget = { session: string } | { task: string };

export class Agents {
  readonly #deps: AgentsDeps;
  readonly #sessions: ListedSessions;
  readonly #tokens = new SessionTokens();
  readonly #tasks: AgentTasks;
  readonly #proposals = new TaskProposals(() => this.#queues.follow());
  readonly #reviews = new TaskReviews(() => this.#queues.follow());
  readonly #miseTrust = new MiseTrustNotices(() => this.#queues.follow());
  readonly #handoffs: HandoffWatch;
  readonly #coordination: TaskCoordination;
  readonly #supervisor: SupervisorSessions;
  readonly #resumable: ResumableSessions;
  /** The sessions the previous daemon left running, until `resumeLeftSessions` takes them (ADR-95). */
  #left: ResumableSession[] = [];
  readonly #lastSupervisor: LastSupervisorFile;
  readonly #queues: AgentQueuesFile;
  /** The sessions a restart is stopping and starting again: a second restart of one would unlist the first one's new session. */
  readonly #restarting = new Set<string>();
  readonly #launcher: SessionLauncher;

  constructor(deps: AgentsDeps) {
    this.#deps = deps;
    this.#launcher = new SessionLauncher({
      procs: deps.procs,
      repos: deps.repos,
      home: deps.home,
      copilot: deps.copilot,
      version: deps.version,
      env: deps.env,
      miseEnv: deps.miseEnv,
      sessionHook: deps.sessionHook,
      sessionMcpServer: deps.sessionMcpServer,
      log: deps.log,
      tokens: this.#tokens,
      callbacks: (session) => this.#sessionCallbacks(session),
      handoff: (task) => this.#tasks.handoff(task),
    });
    this.#resumable = new ResumableSessions(join(deps.home, RESUMABLE_SESSIONS_FILE), deps.log);
    this.#lastSupervisor = new LastSupervisorFile(join(deps.home, LAST_SUPERVISOR_FILE), deps.log);
    this.#sessions = new ListedSessions({
      state: (owner) => deps.procs.state(owner),
      home: deps.home,
      tokens: this.#tokens,
      resumable: this.#resumable,
      lastSupervisor: this.#lastSupervisor,
      log: deps.log,
    });
    this.#supervisor = new SupervisorSessions({
      sessions: this.#sessions,
      lastSupervisor: this.#lastSupervisor,
      projectsDir: () => deps.repos.projectsDir(),
      launch: (spec, place) => this.#launchAs(spec, place),
      close: (id) => this.#close(id),
    });
    this.#tasks = new AgentTasks({
      vcs: deps.vcs,
      repos: deps.repos,
      file: new TaskFile(join(deps.home, TASKS_FILE), deps.log),
      liveIn: (dir) => deps.procs.liveIn(dir),
      legacyWorktreesDir: join(deps.home, LEGACY_WORKTREES_DIR),
      openEditor: deps.openEditor,
      log: deps.log,
      sessions: {
        launch: (spec) => this.#launchTask(spec),
        of: (task) => this.#sessions.views().filter((s) => s.task === task),
        close: (id) => this.#close(id),
      },
    });
    this.#handoffs = new HandoffWatch(this.#tasks, (task) => this.#sessions.runningOfTask(task)?.askToRead(), deps.log);
    this.#coordination = new TaskCoordination({
      task: (id) => this.task(id),
      findTask: (id) => this.findTask(id),
      proposedBy: (id) => proposedByOf(this.session(id)),
      proposerKey: (id) => proposerKeyOf(this.session(id)),
      runningOfTask: (task) => this.#sessions.runningOfTask(task),
      runningProposer: (proposer) => this.#runningProposer(proposer),
      hasProposer: (proposer) =>
        proposerExists(proposer, { hasTask: (task) => this.#tasks.find(task) !== undefined, hasSession: (id) => this.#sessions.has(id) }),
      changed: () => this.#queues.follow(),
      log: deps.log,
    });
    this.#queues = new AgentQueuesFile(join(deps.home, AGENT_QUEUES_FILE), deps.log, {
      proposals: this.#proposals,
      reviews: this.#reviews,
      coordination: this.#coordination,
      trustNotices: this.#miseTrust,
    });
  }

  /** Whether `tasks.json` was read at daemon start; without it tasks may exist that the list does not show. */
  taskListRead(): boolean {
    return this.#tasks.taskListRead;
  }

  sessions(): SessionList {
    return this.#list(this.#sessions.views());
  }

  /**
   * The same list without a session cycle of its own (`ListedSessions.viewsWithoutCycle`, `TICK_MS` in
   * `listed-sessions.ts`), for the `/ws` events, which read it every cycle: a cycle of their own doubled the cycles
   * while a window listened (ADR-36).
   */
  sessionsWithoutCycle(): SessionList {
    return this.#list(this.#sessions.viewsWithoutCycle());
  }

  #list(sessions: Session[]): SessionList {
    const tasks = this.#tasks.list();
    // A proposal being approved that is already a task is only a task: the UI and `list_sessions` see one object.
    const proposals = this.#proposals.list().filter((p) => !tasks.some((t) => t.id === p.id));
    const lastSupervisor = this.#supervisor.resumable()?.session ?? null;
    return { sessions, tasks, proposals, messages: this.#coordination.messages(), lastSupervisor };
  }

  /** One listed session (`not_found` when it does not exist or the user closed it). */
  session(id: string): Session {
    return this.#sessions.view(this.#sessions.get(id));
  }

  /**
   * A main session in the root of `repo`, or with `repo: null` a free session in the projects folder (ADR-100), with
   * `prompt` as its first message (`--interactive`) when there is one. Its id is also Copilot CLI's session id, so a
   * restart can resume it (ADR-95).
   */
  async start(repo: string | null, prompt?: string): Promise<Session> {
    const id = randomUUID();
    const cwd = repo === null ? await this.#deps.repos.projectsDir() : await this.#deps.repos.repoPath(repo);
    const args = [`--session-id=${id}`, ...(prompt === undefined ? [] : [`--interactive=${prompt}`])];
    const started = prompt !== undefined;
    return this.#launch({ id, repo, supervisor: false, cwd, task: null, args, promptOnStart: started, hasConversation: started });
  }

  /** The supervisor (ADR-58): `SupervisorSessions.start`. */
  startSupervisor(conversation: SupervisorConversation, view: SessionView): Promise<Session> {
    return this.#supervisor.start(conversation, view);
  }

  /** The day start's supervisor (ADR-70): `SupervisorSessions.startWith`. */
  startSupervisorWith(firstMessage: string, view: SessionView): Promise<Session> {
    return this.#supervisor.startWith(firstMessage, view);
  }

  /** `SupervisorSessions.assertNone`. */
  assertNoSupervisor(): void {
    this.#supervisor.assertNone();
  }

  /** The session whose session token came with an MCP request or a hook; `undefined` for an unknown token. */
  callerSession(token: string): string | undefined {
    return this.#tokens.session(token);
  }

  /**
   * A hook the plugin of session `id` POSTed (ADR-88), recognised by its session token (`callerSession`): its record
   * goes to the session's `hooks.jsonl`, which the session reads as before, and the answer is the hook's output for
   * Copilot CLI: what waits for the session at the end of a turn or with a tool's result (`LiveSession.hookOutput`,
   * ADR-85), otherwise empty. A payload that is not a JSON object leaves no record, like a broken hook. A session closed
   * while the hook's body arrived is refused like its token, before its removed directory is written to.
   */
  receiveHook(id: string, event: string, payload: string): CopilotHookOutput {
    if (!this.#tokens.holds(id)) throw new DomainError("unauthorized", "unknown session token: this Trackwall session has ended");
    const hook = CopilotHookEvent.safeParse(event);
    if (!hook.success) throw new DomainError("not_found", `no hook ${event}`);
    const record = appendHookRecord(sessionHooksFile(this.#deps.home, id), hook.data, payload);
    return this.#sessions.find(id)?.hookOutput(record) ?? {};
  }

  /** A task proposal from session `caller` (`null`: an agent outside Trackwall) in a repo from the projects folder (ADR-39). */
  async propose(
    caller: string | null,
    proposal: Pick<TaskProposal, "repo" | "title" | "prompt" | "model" | "approvals" | "item">,
  ): Promise<TaskProposal> {
    await this.#deps.repos.repoPath(proposal.repo);
    await this.#assertOnBoard(proposal.item);
    const proposedBy = proposedByOf(caller === null ? null : this.session(caller));
    return this.#proposals.add({ kind: "task", ...proposal, proposedBy });
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
    return this.#proposals.add(
      {
        kind: "remove_repo",
        repo,
        title: `Remove ${repo} from the projects folder`,
        prompt: reason,
        model: null,
        approvals: "ask",
        item: null,
        proposedBy: proposedByOf(session),
      },
      repoDir,
    );
  }

  /**
   * A task from a proposal, with the prompt, the model (ADR-98), the approvals mode (ADR-105) and the view (ADR-137) as the user left them. The proposal stays on the list until there is a task with
   * its identifier, but a second approval is `not_found`; it waits for a decision again when the task was not created. A
   * task left behind by a failed cleanup is ended by the user, so the proposal then disappears.
   */
  async approveProposal(id: string, prompt: string, model: string | null, approvals: TaskApprovals, view: SessionView): Promise<Task> {
    if (this.#proposals.get(id).kind !== "task") throw new DomainError("bad_request", `proposal ${id} is not a task`);
    const { repo, title, proposedBy, item } = this.#proposals.take(id);
    try {
      return await this.#tasks.create(repo, prompt, { id, title, proposedBy, model, approvals, javaNavigation: false, item, view });
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
    if (proposal.kind !== "remove_repo") throw new DomainError("bad_request", `proposal ${id} is not a repo removal`);
    const repoDir = this.#proposals.removalDir(id);
    if (repoDir === undefined) throw new Error(`repo removal ${id} has no folder`);
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
    this.#coordination.repoRemoved(proposal, movedTo);
    for (const other of this.#proposals.list())
      if (other.repo === proposal.repo && this.#proposals.find(other.id))
        this.rejectProposal(other.id, `${proposal.repo} was removed from the projects folder`);
  }

  #assertNothingRunsIn(repo: string, repoDir: string): void {
    const sessions = this.#sessions.views().filter((s) => s.repo === repo && s.task === null && s.run.kind !== "exited");
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
    const running = this.#sessions.runningOfTask(id);
    return { unread, delivery: running ? running.askToRead() : "on_resume" };
  }

  /** The prompt for what waits unread for a session: its task's review comments and messages, and its updates. */
  #inboxPrompt(session: { id: string; supervisor: boolean; task: string | null }): string | undefined {
    const reviewComments = session.task === null ? 0 : this.#reviews.unread(session.task);
    return inboxPrompt({
      reviewComments,
      handoffMoved: session.task !== null && this.#handoffs.waiting(session.task),
      ...this.#coordination.unread(session),
      trustNotice: this.#miseTrust.waiting(trustRecipientOf(session)),
    });
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

  /** Where the work session `caller`'s own task builds on is now (`get_handoff`, ADR-144), whose head now counts as read. */
  async readHandoff(caller: string | null): Promise<TaskHandoffState | null> {
    const task = caller === null ? null : this.session(caller).task;
    if (task === null) throw new DomainError("bad_request", "only a session that runs a task in Trackwall has a handoff");
    return this.#handoffs.read(task);
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
      const session = this.#sessions.views().find((s) => s.task === task.id) ?? null;
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

  /**
   * A task the user typed; its agent asks before tools unless the user chose `auto` (ADR-105), runs on `model`, or
   * Copilot CLI's default when it is `null` (ADR-98), with `javaNavigation` gets the Java language server (ADR-99),
   * works on board item `item` (ADR-133), which must be on the board (`not_found` otherwise), and shows in `view`
   * (ADR-137).
   */
  async createTask(
    repo: string,
    prompt: string,
    { approvals = "ask", model = null, javaNavigation = false, item = null, view = "terminal" }: Partial<TaskOptions> = {},
  ): Promise<Task> {
    await this.#assertOnBoard(item);
    const origin = { id: randomUUID(), title: null, proposedBy: null, model, approvals, javaNavigation, item, view };
    return this.#tasks.create(repo, prompt, origin);
  }

  /**
   * Where session `caller`'s agent writes down what it finds (ADR-133): the task it works on, and that task's board item
   * while the item is still on the board; both `null` for a session without a task.
   */
  async findingsPlace(caller: string | null): Promise<{ task: string | null; item: string | null }> {
    const task = caller === null ? null : this.session(caller).task;
    const item = task === null ? null : this.task(task).item;
    return { task, item: item !== null && (await this.#deps.boardHas(item)) ? item : null };
  }

  async #assertOnBoard(item: string | null): Promise<void> {
    if (item !== null && !(await this.#deps.boardHas(item))) throw new DomainError("not_found", `no board item ${item}`);
  }

  /** What the New session form offers on this computer: whether tasks can get Java navigation now, or why not (ADR-99). */
  startOptions(): StartOptions {
    return { javaNavigation: javaNavigationState(this.#tasks.javaNavigation()) };
  }

  resumeTask(id: string): Promise<Task> {
    return this.#tasks.resume(id);
  }

  /**
   * `resume_task` from session `caller` (`null`: an agent outside Trackwall, the user's program, which resumes any task,
   * ADR-90): the supervisor resumes any task, a main session only the tasks it proposed, a task session none.
   * Returns the task and its new session.
   */
  async resumeTaskFor(caller: string | null, id: string): Promise<{ task: Task; session: Session }> {
    const task = this.#tasks.task(id);
    const session = caller === null ? null : this.session(caller);
    if (session?.task != null) throw new DomainError("bad_request", `a task session resumes no task; ask the user to resume task ${id}`);
    if (session && !isSupervisor(session) && proposerOf(task.proposedBy) !== proposerKeyOf(session))
      throw new DomainError("bad_request", `task ${id} was not proposed by this session; ask the user to resume it`);
    const resumed = await this.#tasks.resume(id);
    return { task: resumed, session: this.#sessionOfTask(id) };
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

  /** How the task's Java language server is doing (ADR-124); `null` for a task without Java navigation. */
  taskJavaNavigation(id: string): Promise<JavaNavigationStatus | null> {
    return this.#tasks.javaNavigationStatus(id);
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

  /** The files the repo root's `.worktreeinclude` names, copied into the task's existing worktree again (ADR-61). */
  copyIncludedFilesAgain(id: string): Promise<Task> {
    return this.#tasks.copyIncludedFilesAgain(id);
  }

  /** The task worktree's mise config against the one the user trusted (ADR-59). */
  taskMiseConfig(id: string): Promise<TaskMiseConfig> {
    return this.#tasks.miseConfig(id);
  }

  /** The user trusts the worktree's mise config they saw (`digest`), only from the UI (ADR-59). */
  async trustTaskMiseConfig(id: string, digest: string): Promise<TaskMiseConfig> {
    const { repo } = this.task(id);
    const trusted = await this.#tasks.trustMiseConfig(id, digest);
    this.miseTrusted({ repo, task: id });
    return trusted;
  }

  /**
   * Runs `run`, which session `caller` asked for and which needs the mise config of `target` trusted (a mise task, a
   * verification or a service; ADR-92). A refusal (`mise_unavailable`) is remembered, so the session hears when the
   * user trusts the config; any try drops what an earlier refusal waited for.
   */
  async runNeedingMiseTrust<T>(caller: string | null, target: MiseTarget, run: () => Promise<T>): Promise<T> {
    const session = caller === null ? undefined : this.#sessions.find(caller);
    if (session === undefined) return run();
    const recipient = trustRecipientOf(session);
    this.#miseTrust.forget(recipient);
    try {
      return await run();
    } catch (err) {
      // A session that closed meanwhile, or a task that ended, has nobody to tell; a task's next session does.
      const stillThere = "task" in recipient ? this.#tasks.find(recipient.task) !== undefined : this.#sessions.has(session.id);
      if (err instanceof DomainError && err.code === "mise_unavailable" && stillThere) this.#miseTrust.refused(recipient, target);
      throw err;
    }
  }

  /**
   * The user trusted the mise config of `target` (ADR-92): the repo root's (`mise trust`) or a task worktree's. Every
   * running session a run there was refused to is asked to run it again, now or after its turn. Called inside the
   * user's trust action, which a session's failure must not fail: the trust is stored by then.
   */
  miseTrusted(target: MiseTarget): void {
    for (const recipient of this.#miseTrust.trusted(target)) {
      const session = this.#runningOf(recipient);
      if (session === undefined) {
        this.#miseTrust.notReached(recipient);
        continue;
      }
      try {
        session.askToRead();
      } catch (err) {
        this.#deps.log(`session ${session.id}: telling it the user trusted the mise config: ${String(err)}`);
      }
    }
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
    this.#miseTrust.forget({ task: id });
    this.#handoffs.forget(id);
    this.#coordination.taskEnded(id);
    this.#deps.onTaskRemoved(id);
  }

  /** A start in a terminal; a new id by default. */
  async #launch({ id = randomUUID(), ...spec }: Omit<TerminalLaunch, "id"> & { id?: string }): Promise<Session> {
    this.#assertNotListed(id);
    return this.#listed(await this.#launcher.terminal({ id, ...spec }));
  }

  /**
   * A task's session in the task's view (ADR-137), under a new id: the task's conversation is under the task's id in a
   * terminal and under Copilot CLI's id in the conversation view, which it resolves to.
   */
  async #launchTask({ repo, cwd, task, args, ...start }: TaskLaunch): Promise<string | undefined> {
    const place = { repo, supervisor: false, cwd, task };
    if (start.view === "terminal") {
      const { promptOnStart, lspServers } = start;
      await this.#launch({ ...place, args, promptOnStart, hasConversation: true, lspServers });
      return undefined;
    }
    const started = await this.#launcher.conversation({
      id: randomUUID(),
      ...place,
      args,
      load: start.load,
      firstMessage: start.firstMessage,
    });
    this.#listed(started);
    return started.session.conversation;
  }

  /** A started session joins the list. */
  #listed({ session, miseEnv, mise }: StartedSession): Session {
    this.#sessions.add({ session, miseEnv, mise });
    // A review or a message sent while the task had no running session (ADR-62, ADR-68); the prompt names only what is
    // unread, and nothing is typed when nothing is. Not the updates of a new supervisor or main session: the user starts
    // those to talk, and the next update asks them anyway.
    if (session.task !== null) session.askToRead();
    // A move of the handing branch before a daemon restart, or while the task had no session (ADR-144).
    if (session.task !== null) void this.#handoffs.check(session.task);
    return this.#sessions.view(session);
  }

  async stop(id: string): Promise<Session> {
    const session = this.#sessions.get(id);
    await this.#deps.procs.stop(sessionOwner(id));
    return this.#sessions.view(session);
  }

  /**
   * How the environment mise would give the running session now differs from the one it started with (ADR-119);
   * `change: null` for none, and for an ended session, which starts with the new one anyway.
   */
  async environmentChange(id: string): Promise<EnvironmentCheck> {
    const session = this.#sessions.get(id);
    if (!this.#sessions.isRunning(session)) return { change: null };
    const { miseEnv, mise } = await this.#launcher.mise({ repo: session.repo, task: session.task });
    return { change: this.#sessions.environmentChange(id, miseEnv, mise) };
  }

  /**
   * A running session stops and starts again with its conversation (ADR-119), the way a daemon restart resumes it
   * (ADR-95): a task's session as Resume does, the supervisor, a free session and a main session under their id. The
   * new start reads the environment, `agentSecrets` and tool permissions again. A main or free session gives up its
   * place in the list before the start, since an id is listed once, so a failed start leaves it out of the list;
   * Copilot CLI still keeps its conversation.
   */
  async restart(id: string): Promise<Session> {
    const session = this.#sessions.get(id);
    if (this.#restarting.has(id)) throw new DomainError("bad_request", "the session is already restarting");
    if (!this.#sessions.isRunning(session)) throw new DomainError("bad_request", "the session has ended; start it again instead");
    const { supervisor, task } = session;
    const left = resumableOf(session);
    this.#restarting.add(id);
    try {
      // What can refuse the start (a bad name in `agentSecrets`, Copilot CLI gone) refuses it before the stop, so the
      // session goes on as it was.
      await this.#launcher.inputs(session);
      // The user may have stopped or closed the session meanwhile: it is not started again behind their back.
      if (this.#sessions.find(id) !== session || !this.#sessions.isRunning(session))
        throw new DomainError("bad_request", "the session has ended; start it again instead");
      await this.#deps.procs.stop(sessionOwner(id));
      if (task === null && !supervisor) this.#unlist(session);
      return await this.#resumeLeft(left);
    } finally {
      this.#restarting.delete(id);
    }
  }

  /** Answers a running session's approval from outside its terminal (ADR-66); see `LiveSession.answerDialog`. */
  answerDialog(id: string, dialog: string, answer: DialogAnswer): Session {
    const session = this.#sessions.get(id);
    // The state after the hooks already written, so that an approval just answered in the terminal is not answered again.
    if (!this.#sessions.isRunning(session)) throw new DomainError("dialog_changed", "the session is no longer running");
    session.answerDialog(dialog, answer);
    return this.#sessions.view(session);
  }

  /** Closes an ended session: it disappears from the list, and its files from the state directory. The session's task stays. */
  dismiss(id: string): SessionList {
    this.#close(id);
    return this.sessions();
  }

  /** A session terminal: first the screen image, then live output, and `onClosed` when the session disappears. */
  attach(id: string, viewer: ScreenViewer, onSnapshot: (snapshot: string) => void, onClosed: () => void): SessionWindow {
    const session = this.#sessions.get(id);
    if (!(session instanceof LiveSession)) throw new DomainError("bad_request", `session ${id} shows as a conversation, not a terminal`);
    return session.attach(viewer, onSnapshot, onClosed);
  }

  /** A session's conversation view (ADR-107): all entries, then the changed ones, and `closed` when the session disappears. */
  attachConversation(id: string, viewer: ConversationViewer): ConversationWindow {
    return this.#conversationOf(id).attachConversation(viewer);
  }

  /** A message from the user to a session in the conversation view (ADR-107). */
  say(id: string, text: string): Session {
    const session = this.#conversationOf(id);
    if (!this.#sessions.isRunning(session)) throw new DomainError("bad_request", "the session is no longer running");
    session.say(text);
    return this.#sessions.view(session);
  }

  /** Stops the turn of a session in the conversation view (ADR-107). */
  interrupt(id: string): Session {
    const session = this.#conversationOf(id);
    session.interrupt();
    return this.#sessions.view(session);
  }

  #conversationOf(id: string): AcpSession {
    const session = this.#sessions.get(id);
    if (!(session instanceof AcpSession)) throw new DomainError("bad_request", `session ${id} runs in a terminal, not as a conversation`);
    return session;
  }

  /**
   * Daemon start: session files from the previous run (sessions do not outlive the daemon), the list of the sessions it
   * left running, which `resumeLeftSessions` resumes once the API listens (ADR-95), and the queues it left (ADR-115).
   */
  sweepLeftovers(): void {
    this.#left = this.#resumable.read();
    const resumedUnderId = new Set(this.#left.filter((s) => s.task === null).map((s) => s.session));
    // A task's session comes back under a new id; what waited for its task (messages, updates on its sessions' work,
    // ADR-140) waits for the new one, what waited for its old id has nobody to reach, as when it closes.
    this.#queues.restore({
      hasTask: (task) => this.#tasks.find(task) !== undefined,
      hasSession: (id) => resumedUnderId.has(id),
      hasFolder: (dir) => existsSync(dir),
    });
    try {
      rmSync(sessionsDir(this.#deps.home), { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`cleaning up the session directory: ${String(err)}`);
    }
  }

  /**
   * Daemon start, once the API listens (the sessions' hooks and MCP server need its port): the sessions that ran when
   * the previous daemon stopped go on with their conversations (ADR-95). A task's session resumes as Resume does; the
   * supervisor, a free session and a main session start again under their id with `--resume`. One that cannot (its task
   * was ended, its repo is gone, a supervisor already runs) goes to the log.
   */
  async resumeLeftSessions(): Promise<void> {
    // The supervisor first: the user may start a new one meanwhile, which would leave the old conversation behind.
    const left = [...this.#left].sort((a, b) => Number(b.supervisor) - Number(a.supervisor));
    this.#left = [];
    for (const session of left) {
      try {
        await this.#resumeLeft(session);
        this.#deps.log(`resumed session ${session.session} (${resumablePlace(session)})`);
      } catch (err) {
        this.#deps.log(`resuming session ${session.session}: ${String(err)}`);
        // What waited for it has nobody to reach, as when the user closes a session (ADR-115).
        if (session.task === null) this.#coordination.sessionClosed({ id: session.session, supervisor: session.supervisor, task: null });
      }
    }
  }

  async #resumeLeft(left: ResumableSession): Promise<Session> {
    const { repo, task } = left;
    if (task !== null) {
      await this.#tasks.resume(task);
      return this.#sessionOfTask(task);
    }
    const spec = sessionLaunch(left.view, left);
    if (left.supervisor) {
      const started = await this.#supervisor.resume(spec);
      this.#askToReadLeft(left.session);
      return started;
    }
    const cwd = repo === null ? await this.#deps.repos.projectsDir() : await this.#deps.repos.repoPath(repo);
    const started = await this.#launchAs(spec, { repo, supervisor: false, cwd, task: null });
    this.#askToReadLeft(left.session);
    return started;
  }

  /** The running session behind a proposer key: the running supervisor, a task's newest running session, or the session. */
  #runningProposer(proposer: string): AgentSession | undefined {
    const named = proposerKind(proposer);
    if (named.kind === "task") return this.#sessions.runningOfTask(named.task);
    return this.#sessions.runningWhere((s) => proposerKeyOf(s) === proposer);
  }

  /** A task's only session after resuming it, which closes its ended ones: running, or already ended when its agent exited at once. */
  #sessionOfTask(task: string): Session {
    const session = this.#sessions.views().find((s) => s.task === task);
    if (!session) throw new Error(`task ${task} has no session after resuming`);
    return session;
  }

  /**
   * A supervisor or main session the restart brought back is asked to read the updates it had not read before the stop
   * (ADR-115), unlike a new one (`#listed`); a task's session is asked anyway.
   */
  #askToReadLeft(id: string): void {
    const session = this.#sessions.find(id);
    if (session !== undefined && this.#inboxPrompt(session) !== undefined) session.askToRead();
  }

  /** A start in the view it names, in `place`. */
  async #launchAs(spec: SessionLaunch, place: SessionPlace): Promise<Session> {
    if (spec.view === "terminal") return this.#launch({ ...spec, ...place });
    this.#assertNotListed(spec.id);
    return this.#listed(await this.#launcher.conversation({ ...spec, ...place }));
  }

  /** An id is listed once: a start under a listed id is a bug in the caller, caught before anything is issued for it. */
  #assertNotListed(id: string): void {
    if (this.#sessions.has(id)) throw new Error(`session ${id} is already listed`);
  }

  /**
   * Daemon exit, before `procs.stopAll`: the sessions it stops stay in the list for the next daemon to resume (ADR-95),
   * and the queues stay as they are now (ADR-115), with the user's latest typing in them.
   */
  keepRunningSessionsForResume(): void {
    this.#sessions.keepRunningForResume();
    this.#queues.follow();
    this.#queues.stopFollowing();
  }

  /** Daemon exit: `procs.stopAll` stops the processes, here only the observing ends. */
  close(): void {
    this.#sessions.close();
  }

  #close(id: string): void {
    const session = this.#sessions.get(id);
    if (this.#deps.procs.state(sessionOwner(id))?.kind !== "exited") {
      throw new DomainError("bad_request", "the session is still running; stop it before closing");
    }
    this.#unlist(session);
    this.#coordination.sessionClosed(session);
  }

  /** The session leaves the list with its files; what waits for it in the coordination stays for whoever comes under its id. */
  #unlist(session: AgentSession): void {
    this.#sessions.remove(session);
    // A task's notice stays for its next session, like its reviews and messages.
    if (session.task === null) this.#miseTrust.forget({ session: session.id });
  }

  /** How a session of either view tells the daemon what it did. */
  #sessionCallbacks({ id, supervisor, task }: { id: string; supervisor: boolean; task: string | null }): SessionCallbacks {
    return {
      prompt: () => this.#inboxPrompt({ id, supervisor, task }),
      onUserText: () => this.#coordination.userTyped({ id, task }),
      onPromptSent: () => this.#miseTrust.promptSent(trustRecipientOf({ id, task })),
      onTurnOver: () => {
        if (task !== null) void this.#handoffs.turnOver(task);
      },
      onEvent: (event: SessionEvent) => {
        if (event.kind === "turn_ended") this.#miseTrust.turnEnded(trustRecipientOf({ id, task }));
        // The session reads its hooks inside the user's key or another session's call: news for the proposer must not fail them.
        try {
          this.#coordination.sessionEvent({ id, task }, event);
        } catch (err) {
          this.#deps.log(`session ${id}: telling the proposer: ${String(err)}`);
        }
      },
    };
  }

  /** The running session a trust notice is for: the newest one of its task, or the session itself. */
  #runningOf(recipient: TrustRecipient): AgentSession | undefined {
    if ("task" in recipient) return this.#sessions.runningOfTask(recipient.task);
    const session = this.#sessions.find(recipient.session);
    return session !== undefined && this.#sessions.isRunning(session) ? session : undefined;
  }
}
