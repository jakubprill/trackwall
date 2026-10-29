import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTaskChanges,
  copilotHttpMcpServers,
  type DialogAnswer,
  type EnvironmentCheck,
  type HttpEndpoint,
  isSupervisor,
  type MiseTarget,
  type ReviewComment,
  type RunState,
  type SendMessageResult,
  type SendReviewResult,
  type Session,
  type SessionEnvironment,
  type SessionList,
  type SessionView,
  type SupervisorConversation,
  type SupervisorSettings,
  type Task,
  type TaskApprovals,
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
import { AcpSession, type ConversationViewer, type ConversationWindow } from "./acp-session.ts";
import type { AgentSession } from "./agent-session.ts";
import { resolveCopilot, toolPermissionArgs } from "./copilot-command.ts";
import type { CopilotHookOutput } from "./copilot-hook-output.ts";
import { CopilotHookEvent } from "./copilot-hook-record.ts";
import { writeCopilotPlugin } from "./copilot-plugin.ts";
import { appendHookRecord } from "./hook-tail.ts";
import { inboxPrompt } from "./inbox-prompt.ts";
import { type LastSupervisor, LastSupervisorFile } from "./last-supervisor.ts";
import { LiveSession, type SessionEvent, type SessionPty, type SessionWindow } from "./live-session.ts";
import { MiseTrustNotices } from "./mise-trust-notices.ts";
import { withLoopbackNoProxy } from "./no-proxy.ts";
import { proposedByOf, proposerKeyOf, proposerOf, SUPERVISOR } from "./proposer.ts";
import {
  type ConversationLaunch,
  type ResumableSession,
  ResumableSessions,
  resumablePlace,
  type SessionLaunch,
  sessionLaunch,
} from "./resumable-sessions.ts";
import { type SessionMiseEnv, sessionMiseLaunch } from "./session-env.ts";
import { SessionEnvironments } from "./session-env-change.ts";
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
/** The hook records of the hooks the session plugin POSTs to the daemon (ADR-88; `HookTail` reads them). */
const HOOKS_FILENAME = "hooks.jsonl";
const SESSIONS_DIR = "sessions";
/** Without it Copilot CLI silently drops the session plugin's hooks, which POST to the daemon on `127.0.0.1` (ADR-88). */
const LOOPBACK_HOOKS_ENV = { COPILOT_HOOK_ALLOW_LOCALHOST: "1" };
export const TASKS_FILE = "tasks.json";
/** The sessions that run, for the next daemon to resume (ADR-95). */
export const RESUMABLE_SESSIONS_FILE = "resumable-sessions.json";
export const LAST_SUPERVISOR_FILE = "last-supervisor.json";
/** Where task worktrees went before ADR-84; tasks from then keep them there until they end. */
export const LEGACY_WORKTREES_DIR = "worktrees";

/** A session's directory in the state directory: its plugin, MCP configuration, token and hook records. */
function sessionDir(home: string, id: string): string {
  return join(home, SESSIONS_DIR, id);
}

/** A session's MCP configuration, which names the Trackwall server with the session's tokens (ADR-39, ADR-89). */
export function sessionMcpConfigFile(home: string, id: string): string {
  return join(sessionDir(home, id), MCP_CONFIG_FILE);
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
    secrets: readonly string[];
    cols: number;
    rows: number;
    onData: (bytes: Uint8Array) => void;
  }): Promise<{ run: RunState; terminal: SessionPty }>;
  /** A session in the conversation view (ADR-107): Copilot CLI over ACP on its standard streams. */
  startChannel(spec: {
    owner: string;
    command: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    secrets: readonly string[];
    onStdout: (chunk: Buffer) => void;
  }): Promise<{ run: RunState; channel: { write(data: string): void } }>;
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
  /** The task worktrees folder for a new task (ADR-84). */
  worktreesDir(): Promise<string>;
  /** The `toolPermissions` patterns for a session in repo `repo` (`null` in the projects folder) or the supervisor, ADR-66. */
  toolPermissions(session: Pick<Session, "repo" | "supervisor">): ToolPermissions;
  /** `supervisor` from `workspace.yaml` (ADR-78); `invalid_config` for a bad key. */
  supervisorSettings(): SupervisorSettings;
  /** `agentSecrets` from `workspace.yaml` (ADR-93): the secrets from mise a session's tools get; `invalid_config` for a bad key. */
  agentSecrets(): readonly string[];
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
   * Where the session plugin's hook for an event POSTs its payload (ADR-88): the daemon's hook route with the daemon token
   * and the session token, which `receiveHook` takes; the API's port is known only once it listens.
   */
  sessionHook: (event: CopilotHookEvent, sessionToken: string) => HttpEndpoint;
  /**
   * The daemon's MCP server (§5.3) over HTTP with the daemon token and the session token (ADR-39, ADR-89): every
   * session gets the `trackwall` server through `--additional-mcp-config`, and the server knows from the token which
   * session is calling.
   */
  sessionMcpServer: (sessionToken: string) => HttpEndpoint;
  /** Opens a directory in VS Code (a task's worktree). */
  openEditor: (dir: string) => void;
  log: (msg: string) => void;
}

/** What `wait_for_session` waits for: a session or a task (also a proposal that is about to become a task). */
export type WaitTarget = { session: string } | { task: string };

export class Agents {
  readonly #deps: AgentsDeps;
  readonly #sessions = new Map<string, AgentSession>();
  readonly #tokens = new SessionTokens();
  readonly #tasks: AgentTasks;
  readonly #proposals = new TaskProposals();
  /** The folder each waiting repo removal names, fixed when it was proposed: approval moves that folder or none (ADR-83). */
  readonly #removalDirs = new Map<string, string>();
  readonly #reviews = new TaskReviews();
  readonly #miseTrust = new MiseTrustNotices();
  readonly #coordination: TaskCoordination;
  /** The supervisor start under way, so that two requests at once start one supervisor, not two (ADR-58). */
  #supervisorStart: Promise<Session> | undefined;
  #timer: NodeJS.Timeout | undefined;
  readonly #resumable: ResumableSessions;
  /** The sessions the previous daemon left running, until `resumeLeftSessions` takes them (ADR-95). */
  #left: ResumableSession[] = [];
  readonly #lastSupervisor: LastSupervisorFile;
  /** The environment each listed session started with, to tell when mise would give it another one (ADR-119). */
  readonly #environments = new SessionEnvironments();
  /** The sessions a restart is stopping and starting again: a second restart of one would unlist the first one's new session. */
  readonly #restarting = new Set<string>();

  constructor(deps: AgentsDeps) {
    this.#deps = deps;
    this.#resumable = new ResumableSessions(join(deps.home, RESUMABLE_SESSIONS_FILE), deps.log);
    this.#lastSupervisor = new LastSupervisorFile(join(deps.home, LAST_SUPERVISOR_FILE), deps.log);
    this.#tasks = new AgentTasks({
      vcs: deps.vcs,
      repos: deps.repos,
      file: new TaskFile(join(deps.home, TASKS_FILE), deps.log),
      liveIn: (dir) => deps.procs.liveIn(dir),
      legacyWorktreesDir: join(deps.home, LEGACY_WORKTREES_DIR),
      openEditor: deps.openEditor,
      log: deps.log,
      sessions: {
        launch: (spec) => this.#launch({ ...spec, supervisor: false }),
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
    const lastSupervisor = this.#resumableSupervisor()?.session ?? null;
    return { sessions: this.#views(), tasks, proposals, messages: this.#coordination.messages(), lastSupervisor };
  }

  /** One listed session (`not_found` when it does not exist or the user closed it). */
  session(id: string): Session {
    return this.#view(this.#get(id));
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

  /**
   * The supervisor (ADR-58): Copilot CLI in the projects folder, above the sessions of all repos. At most one runs at a
   * time: while one is starting or runs, this returns it. A new one replaces the ended ones, which are closed once it
   * has started, so a failed start keeps the last screen; the work they delegated stays, marked as the supervisor's
   * (`ProposedBy.supervisor`). With `last` it goes on with the newest supervisor's conversation under its id (ADR-96);
   * that start closes the ended supervisor first, since an id is listed once, so when it fails the last screen is gone.
   * `view` is a terminal or the conversation view (ADR-107); the last conversation goes on in either.
   */
  async startSupervisor(conversation: SupervisorConversation, view: SessionView): Promise<Session> {
    if (this.#supervisorStart) return this.#supervisorStart;
    const running = this.#runningSupervisor();
    if (running) return running;
    const last = conversation === "last" ? this.#resumableSupervisor() : undefined;
    return last === undefined ? this.#startNewSupervisor(null, view) : this.#startSupervisorAs(sessionLaunch(view, last));
  }

  /** The newest supervisor while Copilot CLI keeps its conversation, which a start with `last` goes on with (ADR-96). */
  #resumableSupervisor(): LastSupervisor | undefined {
    const last = this.#lastSupervisor.read();
    return last?.hasConversation ? last : undefined;
  }

  /**
   * A new supervisor with `firstMessage` as its first message (`--interactive`), so it works from the start: the day start
   * (ADR-70). While a supervisor starts or runs, `bad_request`: the user stops it first, so no conversation ends without them.
   */
  async startSupervisorWith(firstMessage: string, view: SessionView): Promise<Session> {
    this.assertNoSupervisor();
    return this.#startNewSupervisor(firstMessage, view);
  }

  /** `bad_request` while a supervisor starts or runs (ADR-70). */
  assertNoSupervisor(): void {
    if (this.#supervisorStart || this.#runningSupervisor())
      throw new DomainError("bad_request", "the supervisor is running; stop it to start your day with a new one");
  }

  #runningSupervisor(): Session | undefined {
    return this.#views().find((s) => isSupervisor(s) && s.run.kind !== "exited");
  }

  /**
   * `firstMessage` is the first message (`--interactive`) of the new supervisor; `null` for none. In a terminal its id
   * is also Copilot CLI's session id, so a restart can resume it (ADR-95); in the conversation view Copilot CLI picks
   * the conversation's id (ADR-107).
   */
  #startNewSupervisor(firstMessage: string | null, view: SessionView): Promise<Session> {
    const id = randomUUID();
    if (view === "conversation") return this.#startSupervisorAs({ view, id, load: undefined, firstMessage: firstMessage ?? undefined });
    const args = [`--session-id=${id}`, ...(firstMessage === null ? [] : [`--interactive=${firstMessage}`])];
    const started = firstMessage !== null;
    return this.#startSupervisorAs({ view, id, args, promptOnStart: started, hasConversation: started, conversation: id });
  }

  #startSupervisorAs(spec: SessionLaunch): Promise<Session> {
    this.#supervisorStart = this.#replaceSupervisor(spec).finally(() => {
      this.#supervisorStart = undefined;
    });
    return this.#supervisorStart;
  }

  async #replaceSupervisor(spec: SessionLaunch): Promise<Session> {
    const ended = this.#views().filter(isSupervisor);
    const cwd = await this.#deps.repos.projectsDir();
    // The ended supervisor whose conversation this one goes on with under its id gives up its place before the start.
    if (this.#sessions.has(spec.id)) this.#close(spec.id);
    const started = await this.#launchAs(spec, { repo: null, supervisor: true, cwd, task: null });
    // One of them may have been dismissed during the start; the start has still succeeded.
    for (const old of ended) if (old.id !== spec.id && this.#sessions.has(old.id)) this.#close(old.id);
    return started;
  }

  /** The session whose session token came with an MCP request; `undefined` for an unknown token. */
  callerSession(token: string): string | undefined {
    return this.#tokens.session(token);
  }

  /**
   * A hook the plugin of the session with token `sessionToken` POSTed (ADR-88): its record goes to the session's
   * `hooks.jsonl`, which the session reads as before, and the answer is the hook's output for Copilot CLI: what waits
   * for the session at the end of a turn or with a tool's result (`LiveSession.hookOutput`, ADR-85), otherwise empty.
   * A payload that is not a JSON object leaves no record, like a broken hook.
   */
  receiveHook(sessionToken: string, event: string, payload: string): CopilotHookOutput {
    const id = this.#tokens.session(sessionToken);
    if (id === undefined) throw new DomainError("unauthorized", "unknown session token: this Trackwall session has ended");
    const hook = CopilotHookEvent.safeParse(event);
    if (!hook.success) throw new DomainError("not_found", `no hook ${event}`);
    const record = appendHookRecord(sessionHooksFile(this.#deps.home, id), hook.data, payload);
    return this.#sessions.get(id)?.hookOutput(record) ?? {};
  }

  /** A task proposal from session `caller` (`null`: an agent outside Trackwall) in a repo from the projects folder (ADR-39). */
  async propose(
    caller: string | null,
    proposal: Pick<TaskProposal, "repo" | "title" | "prompt" | "model" | "approvals">,
  ): Promise<TaskProposal> {
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
      model: null,
      approvals: "ask",
      proposedBy: proposedByOf(session),
    });
    this.#removalDirs.set(proposal.id, repoDir);
    return proposal;
  }

  /**
   * A task from a proposal, with the prompt, the model (ADR-98) and the approvals mode (ADR-105) as the user left them. The proposal stays on the list until there is a task with
   * its identifier, but a second approval is `not_found`; it waits for a decision again when the task was not created. A
   * task left behind by a failed cleanup is ended by the user, so the proposal then disappears.
   */
  async approveProposal(id: string, prompt: string, model: string | null, approvals: TaskApprovals): Promise<Task> {
    if (this.#proposals.get(id).kind !== "task") throw new DomainError("bad_request", `proposal ${id} is not a task`);
    const { repo, title, proposedBy } = this.#proposals.take(id);
    try {
      return await this.#tasks.create(repo, prompt, { id, title, proposedBy, model, approvals });
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
  #inboxPrompt(session: { id: string; supervisor: boolean; task: string | null }): string | undefined {
    const reviewComments = session.task === null ? 0 : this.#reviews.unread(session.task);
    return inboxPrompt({ reviewComments, ...this.#coordination.unread(session), trustNotice: this.#miseTrust.waiting(session.id) });
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

  /** A task the user typed; its agent asks before tools unless the user chose `auto` (ADR-105). */
  createTask(repo: string, prompt: string, approvals: TaskApprovals = "ask"): Promise<Task> {
    return this.#tasks.create(repo, prompt, { id: randomUUID(), title: null, proposedBy: null, model: null, approvals });
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
    if (caller === null) return run();
    this.#miseTrust.forget(caller);
    try {
      return await run();
    } catch (err) {
      if (err instanceof DomainError && err.code === "mise_unavailable" && this.#sessions.has(caller))
        this.#miseTrust.refused(caller, target);
      throw err;
    }
  }

  /**
   * The user trusted the mise config of `target` (ADR-92): the repo root's (`mise trust`) or a task worktree's. Every
   * running session a run there was refused to is asked to run it again, now or after its turn. Called inside the
   * user's trust action, which a session's failure must not fail: the trust is stored by then.
   */
  miseTrusted(target: MiseTarget): void {
    for (const id of this.#miseTrust.trusted(target)) {
      const session = this.#sessions.get(id);
      if (session === undefined || !this.#isRunning(session)) {
        this.#miseTrust.forget(id);
        continue;
      }
      try {
        session.askToRead();
      } catch (err) {
        this.#deps.log(`session ${id}: telling it the user trusted the mise config: ${String(err)}`);
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
    this.#coordination.taskEnded(id);
  }

  /**
   * Copilot CLI in `cwd` (the repo root or the worktree of task `task`) with arguments before the session's arguments;
   * `promptOnStart` when the arguments carry the first message (`--interactive`), so the session works from the start.
   */
  async #launch({ id = randomUUID(), args, promptOnStart, hasConversation, conversation, ...place }: LaunchSpec): Promise<Session> {
    const { repo, task, cwd } = place;
    const setup = await this.#setUp(id, place);
    const { program, dir, token, mise } = setup;
    let prepared: PreparedSession;
    try {
      prepared = this.#prepare({
        id,
        ...place,
        role: setup.role,
        dir,
        token,
        promptOnStart,
        hasConversation,
        conversation,
        program,
        environment: mise.environment,
      });
    } catch (err) {
      this.#tokens.revoke(id);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const { session, instructionsDir } = prepared;
    try {
      const { terminal } = await this.#deps.procs.startTerminal({
        owner: owner(id),
        command: [program, ...setup.prefix, "--plugin-dir", join(dir, "plugin"), ...setup.args, ...args],
        cwd,
        env: sessionEnv(setup.env, instructionsDir),
        secrets: mise.secretValues,
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
    this.#listed(session, task, setup);
    return this.#view(session);
  }

  /**
   * Copilot CLI over ACP (ADR-107) in `cwd`: the same MCP server, instructions, tool permissions and mise environment as
   * in a terminal, without the session plugin, since the protocol itself says what the session does.
   */
  async #launchConversation({ id, load, firstMessage, ...place }: ConversationLaunch & SessionPlace): Promise<Session> {
    const { repo, supervisor, task, cwd } = place;
    const setup = await this.#setUp(id, place);
    const { program, dir, token, mise } = setup;
    let instructionsDir: string | null;
    try {
      instructionsDir = this.#writeSessionFiles(id, setup.role, dir, token);
    } catch (err) {
      this.#tokens.revoke(id);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const session = new AcpSession({
      id,
      repo,
      supervisor,
      task,
      cwd,
      load,
      firstMessage,
      environment: mise.environment,
      run: () => this.#deps.procs.state(owner(id)),
      ...this.#sessionCallbacks(id, supervisor, task),
      log: this.#deps.log,
    });
    try {
      const { channel } = await this.#deps.procs.startChannel({
        owner: owner(id),
        command: [program, ...setup.prefix, "--acp", ...setup.args],
        cwd,
        env: sessionEnv(setup.env, instructionsDir),
        secrets: mise.secretValues,
        onStdout: (chunk) => session.output(chunk),
      });
      session.connect(channel);
      await session.start();
    } catch (err) {
      await this.#deps.procs.stop(owner(id)).catch(() => undefined);
      this.#tokens.revoke(id);
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
      throw domainError(repo, err);
    }
    this.#listed(session, task, setup);
    return this.#view(session);
  }

  /** What every start needs: Copilot CLI, the session directory and token, and the arguments and environment it gets. */
  async #setUp(id: string, place: SessionPlace): Promise<SessionSetup> {
    const { repo, supervisor, task } = place;
    const { copilot, permissions, miseEnv, mise } = await this.#startInputs(place);
    // The MCP server and the hooks are the daemon on `127.0.0.1`, which a proxy of the user must not get (ADR-89).
    const env = withLoopbackNoProxy({ ...mise.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...LOOPBACK_HOOKS_ENV });
    if (this.#sessions.has(id)) throw new Error(`session ${id} is already listed`);
    const dir = sessionDir(this.#deps.home, id);
    const args = ["--additional-mcp-config", `@${join(dir, MCP_CONFIG_FILE)}`, ...toolPermissionArgs(permissions), ...mise.args];
    return {
      program: copilot.program,
      prefix: copilot.args,
      args,
      env,
      mise,
      miseEnv,
      role: this.#role(repo, supervisor, task),
      dir,
      token: this.#tokens.issue(id),
    };
  }

  /**
   * What a start reads of the configuration, each of which can refuse it: Copilot CLI, the tool permissions and what
   * mise gives the place with the agent secrets (ADR-93).
   */
  async #startInputs({ repo, supervisor, task }: Pick<SessionPlace, "repo" | "supervisor" | "task">) {
    const userEnv = await this.#deps.env();
    // The user's `PATH`, not mise's: a mise config an agent can change must not choose the program that gets every secret.
    const copilot = resolveCopilot(this.#deps.copilot, userEnv);
    if ("missing" in copilot) throw new DomainError("agent_unavailable", copilot.message);
    const permissions = this.#deps.repos.toolPermissions({ repo, supervisor });
    return { copilot, permissions, ...(await this.#miseLaunch({ repo, task }, userEnv)) };
  }

  /** What mise gives a session in its place now (ADR-93). */
  async #miseLaunch(place: { repo: string | null; task: string | null }, userEnv: NodeJS.ProcessEnv) {
    const miseEnv = await this.#deps.miseEnv(place);
    return { miseEnv, mise: sessionMiseLaunch(miseEnv, userEnv, this.#deps.repos.agentSecrets()) };
  }

  /** A started session joins the list. */
  #listed(session: AgentSession, task: string | null, { miseEnv, mise }: Pick<SessionSetup, "miseEnv" | "mise">): void {
    this.#sessions.set(session.id, session);
    this.#environments.remember(session.id, miseEnv, mise);
    // A review or a message sent while the task had no running session (ADR-62, ADR-68); the prompt names only what is
    // unread, and nothing is typed when nothing is. Not the updates of a new supervisor or main session: the user starts
    // those to talk, and the next update asks them anyway.
    if (task !== null) session.askToRead();
    this.#startTicking();
  }

  #role(repo: string | null, supervisor: boolean, task: string | null): SessionRole {
    if (repo !== null) return { kind: "repo", repo, task };
    return supervisor ? { kind: "supervisor", changesCode: this.#deps.repos.supervisorSettings().changesCode } : { kind: "free" };
  }

  async stop(id: string): Promise<Session> {
    const session = this.#get(id);
    await this.#deps.procs.stop(owner(id));
    return this.#view(session);
  }

  /**
   * How the environment mise would give the running session now differs from the one it started with (ADR-119); `null`
   * for none, and for an ended session, which starts with the new one anyway.
   */
  async environmentChange(id: string): Promise<EnvironmentCheck> {
    const session = this.#get(id);
    if (!this.#isRunning(session)) return { change: null };
    const { miseEnv, mise } = await this.#miseLaunch({ repo: session.repo, task: session.task }, await this.#deps.env());
    return { change: this.#environments.changeSince(id, miseEnv, mise) };
  }

  /**
   * A running session stops and starts again with its conversation (ADR-119), the way a daemon restart resumes it
   * (ADR-95): a task's session as Resume does, the supervisor, a free session and a main session under their id. The
   * new start reads the environment, `agentSecrets` and tool permissions again. A main or free session gives up its
   * place in the list before the start, since an id is listed once, so a failed start leaves it out of the list;
   * Copilot CLI still keeps its conversation.
   */
  async restart(id: string): Promise<Session> {
    const session = this.#get(id);
    if (this.#restarting.has(id)) throw new DomainError("bad_request", "the session is already restarting");
    if (!this.#isRunning(session)) throw new DomainError("bad_request", "the session has ended; start it again instead");
    const { repo, supervisor, task } = session;
    const left: ResumableSession = { session: id, repo, supervisor, task, view: session.sessionView, ...resumedAs(session) };
    this.#restarting.add(id);
    try {
      // What can refuse the start (a bad name in `agentSecrets`, Copilot CLI gone) refuses it before the stop, so the
      // session goes on as it was.
      await this.#startInputs(session);
      await this.#deps.procs.stop(owner(id));
      if (task === null && !supervisor) this.#unlist(session);
      return await this.#resumeLeft(left);
    } finally {
      this.#restarting.delete(id);
    }
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
    const session = this.#get(id);
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
    if (!this.#isRunning(session)) throw new DomainError("bad_request", "the session is no longer running");
    session.say(text);
    return this.#view(session);
  }

  /** Stops the turn of a session in the conversation view (ADR-107). */
  interrupt(id: string): Session {
    const session = this.#conversationOf(id);
    session.interrupt();
    return this.#view(session);
  }

  #conversationOf(id: string): AcpSession {
    const session = this.#get(id);
    if (!(session instanceof AcpSession)) throw new DomainError("bad_request", `session ${id} runs in a terminal, not as a conversation`);
    return session;
  }

  /**
   * Daemon start: session files from the previous run (sessions do not outlive the daemon), and the list of the
   * sessions it left running, which `resumeLeftSessions` resumes once the API listens (ADR-95).
   */
  sweepLeftovers(): void {
    this.#left = this.#resumable.read();
    try {
      rmSync(join(this.#deps.home, SESSIONS_DIR), { recursive: true, force: true });
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
      if (this.#supervisorStart || this.#runningSupervisor()) throw new Error("a supervisor already runs");
      return this.#startSupervisorAs(spec);
    }
    const cwd = repo === null ? await this.#deps.repos.projectsDir() : await this.#deps.repos.repoPath(repo);
    return this.#launchAs(spec, { repo, supervisor: false, cwd, task: null });
  }

  /** A task's only session after resuming it, which closes its ended ones: running, or already ended when its agent exited at once. */
  #sessionOfTask(task: string): Session {
    const session = this.#views().find((s) => s.task === task);
    if (!session) throw new Error(`task ${task} has no session after resuming`);
    return session;
  }

  /** A start in the view it names, in `place`. */
  #launchAs(spec: SessionLaunch, place: SessionPlace): Promise<Session> {
    return spec.view === "terminal" ? this.#launch({ ...spec, ...place }) : this.#launchConversation({ ...spec, ...place });
  }

  /** Daemon exit, before `procs.stopAll`: the sessions it stops stay in the list for the next daemon to resume (ADR-95). */
  keepRunningSessionsForResume(): void {
    // The list of this moment, not of the last check: a session stopped or started since then counts as it is now.
    this.#followLive([...this.#sessions.values()].filter((s) => this.#deps.procs.state(owner(s.id))?.kind === "running"));
    this.#followLastSupervisor();
    this.#resumable.stopFollowing();
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
    this.#unlist(session);
    this.#coordination.sessionClosed(session);
  }

  /** The session leaves the list with its files; what waits for it in the coordination stays for whoever comes under its id. */
  #unlist(session: AgentSession): void {
    this.#sessions.delete(session.id);
    this.#environments.forget(session.id);
    this.#tokens.revoke(session.id);
    this.#miseTrust.forget(session.id);
    session.dispose();
    this.#removeDir(session.id);
  }

  /** Sessions, newest first. */
  #views(): Session[] {
    return [...this.#sessions.values()].flatMap((s) => this.#fresh(s) ?? []).reverse();
  }

  /**
   * The session directory with the session plugin, MCP config, session instructions and an empty
   * `hooks.jsonl`, before Copilot CLI starts.
   */
  #prepare({
    id,
    role,
    repo,
    task,
    dir,
    token,
    promptOnStart,
    hasConversation,
    conversation,
    program,
    environment,
  }: SessionFiles): PreparedSession {
    const supervisor = role.kind === "supervisor";
    const hooksFile = join(dir, HOOKS_FILENAME);
    const instructionsDir = this.#writeSessionFiles(id, role, dir, token);
    writeFileSync(hooksFile, "");
    writeCopilotPlugin(join(dir, "plugin"), (event) => ({ type: "http", ...this.#deps.sessionHook(event, token) }));
    const session = new LiveSession({
      id,
      repo,
      supervisor,
      task,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      hooksFile,
      promptOnStart,
      hasConversation,
      conversation,
      program,
      environment,
      run: () => this.#deps.procs.state(owner(id)),
      ...this.#sessionCallbacks(id, supervisor, task),
    });
    return { session, instructionsDir };
  }

  /**
   * The session directory with the MCP config and session instructions, which both views share; returns the
   * instructions directory, `null` when it could not be written.
   */
  #writeSessionFiles(id: string, role: SessionRole, dir: string, token: string): string | null {
    mkdirSync(dir, { recursive: true });
    // User-only: the server's headers carry the daemon token and the session token (§8).
    const mcpConfig = copilotHttpMcpServers(this.#deps.sessionMcpServer(token));
    writeFileSync(join(dir, MCP_CONFIG_FILE), JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    const instructionsDir = writeSessionInstructions(dir, this.#deps.version, role);
    if (instructionsDir === null)
      this.#deps.log(`session ${id} starts without Trackwall instructions: the session directory path has a comma`);
    return instructionsDir;
  }

  /** How a session of either view tells the daemon what it did. */
  #sessionCallbacks(id: string, supervisor: boolean, task: string | null) {
    return {
      prompt: () => this.#inboxPrompt({ id, supervisor, task }),
      onUserText: () => this.#coordination.userTyped({ id, task }),
      onPromptSent: () => this.#miseTrust.promptSent(id),
      onEvent: (event: SessionEvent) => {
        if (event.kind === "turn_ended") this.#miseTrust.turnEnded(id);
        // The session reads its hooks inside the user's key or another session's call: news for the proposer must not fail them.
        try {
          this.#coordination.sessionEvent({ id, task }, event);
        } catch (err) {
          this.#deps.log(`session ${id}: telling the proposer: ${String(err)}`);
        }
      },
    };
  }

  #startTicking(): void {
    this.#timer ??= setInterval(() => this.#tick(), TICK_MS);
    this.#timer.unref();
  }

  #tick(): void {
    const live: AgentSession[] = [];
    for (const session of this.#sessions.values()) {
      try {
        if (session.tick()) live.push(session);
      } catch (err) {
        live.push(session);
        this.#deps.log(`session ${session.id}: ${String(err)}`);
      }
    }
    this.#followLive(live);
    this.#followLastSupervisor();
    if (live.length === 0) this.close();
  }

  /** The list of running sessions a restart resumes (ADR-95); a failed write is retried at the next tick. */
  #followLive(live: readonly AgentSession[]): void {
    try {
      this.#resumable.follow(
        live.map((s) => ({ session: s.id, repo: s.repo, supervisor: s.supervisor, task: s.task, view: s.sessionView, ...resumedAs(s) })),
      );
    } catch (err) {
      this.#deps.log(`writing ${RESUMABLE_SESSIONS_FILE}: ${String(err)}`);
    }
  }

  /** The newest listed supervisor, which a start with `last` goes on with (ADR-96); a failed write is retried at the next tick. */
  #followLastSupervisor(): void {
    const newest = [...this.#sessions.values()].findLast(isSupervisor);
    if (newest === undefined) return;
    try {
      this.#lastSupervisor.follow({ session: newest.id, ...resumedAs(newest) });
    } catch (err) {
      this.#deps.log(`writing ${LAST_SUPERVISOR_FILE}: ${String(err)}`);
    }
  }

  /** The task's newest session while it runs. */
  #runningOfTask(task: string): AgentSession | undefined {
    return [...this.#sessions.values()].reverse().find((s) => s.task === task && this.#isRunning(s));
  }

  /** The state after the hooks already written, as `#fresh` reads it. */
  #isRunning(session: AgentSession): boolean {
    return this.#fresh(session)?.run.kind === "running";
  }

  #get(id: string): AgentSession {
    const session = this.#sessions.get(id);
    if (!session) throw new DomainError("not_found", `no session ${id}`);
    return session;
  }

  /** The session's state after reading new hook records and the end of the process. */
  #fresh(session: AgentSession): Session | undefined {
    session.tick();
    return session.view();
  }

  #view(session: AgentSession): Session {
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

/**
 * What `#launch` starts: Copilot CLI in a repo root, in a task's worktree, or the supervisor or a free session in the
 * projects folder.
 */
interface LaunchSpec extends SessionPlace {
  /** The session id; a new one by default. */
  id?: string;
  /** Copilot CLI already keeps a conversation under the id: the arguments carry the first message or resume it (ADR-95). */
  hasConversation: boolean;
  /** Copilot CLI's id of the conversation when it is not the session id (ADR-107). */
  conversation?: string;
  args: readonly string[];
  promptOnStart: boolean;
}

/** Where a session runs and what it is. */
interface SessionPlace {
  /** `null` in the projects folder. */
  repo: string | null;
  supervisor: boolean;
  cwd: string;
  task: string | null;
}

/** What `#setUp` gives a start of either view. */
interface SessionSetup {
  program: string;
  /** Arguments of the program before Copilot CLI's own (`node <copilot>.js`). */
  prefix: readonly string[];
  /** The MCP config, tool permissions and mise's arguments. */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  mise: ReturnType<typeof sessionMiseLaunch>;
  /** What mise gave the place, which the session's environment is compared with later (ADR-119). */
  miseEnv: SessionMiseEnv;
  role: SessionRole;
  dir: string;
  token: string;
}

/** The directory of a new session and what follows from it for `LiveSession`. */
interface SessionFiles {
  id: string;
  role: SessionRole;
  repo: string | null;
  task: string | null;
  dir: string;
  token: string;
  promptOnStart: boolean;
  hasConversation: boolean;
  conversation: string | undefined;
  /** The Copilot CLI program the session starts. */
  program: string;
  /** What the session got from mise (ADR-93). */
  environment: SessionEnvironment;
}

/** A prepared session directory: the session and its instructions directory (`null` when it could not be written). */
interface PreparedSession {
  session: LiveSession;
  instructionsDir: string | null;
}

/** The session's environment with the directory of its Trackwall instructions, when there is one. */
function sessionEnv(env: NodeJS.ProcessEnv, instructionsDir: string | null): NodeJS.ProcessEnv {
  return instructionsDir === null ? env : withInstructionsDir(env, instructionsDir);
}

/** How a restart or a start with `last` goes on with the session's conversation (ADR-95, ADR-96, ADR-107). */
function resumedAs(session: AgentSession): { hasConversation: boolean; conversation?: string } {
  const { hasConversation, conversation } = session;
  return conversation === undefined || conversation === session.id ? { hasConversation } : { hasConversation, conversation };
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
