import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTaskChanges,
  type ApproveChangeRequest,
  type AutoReview,
  type AutoReviewSettings,
  CHANGE_PROMPTS_TOO_LONG,
  type ChangePart,
  type ChangeRequest,
  type CreatedChange,
  changePartPrompt,
  changePromptsFit,
  type DialogAnswer,
  type EnvironmentCheck,
  type HttpEndpoint,
  inTurn,
  isSupervisor,
  type JavaNavigationSettings,
  type JavaNavigationState,
  type JavaNavigationStatus,
  type MergeRequest,
  type MessageAttachment,
  type MiseTarget,
  type PromptDelivery,
  proposalRepos,
  type ReviewComment,
  type SandboxSettings,
  type SandboxState,
  type SendMessageResult,
  type SendReviewResult,
  type Session,
  type SessionKnowledge,
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
  type TaskOutcome,
  type TaskProposal,
  type TaskRounds,
  type TaskSharedFiles,
  type TaskUpdate,
  type ToolPermissions,
  type Verification,
  type WorkingTreeChanges,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import type { ScreenViewer } from "../../infra/terminal-screen.ts";
import { AcpSession, type ConversationViewer, type ConversationWindow } from "./acp-session.ts";
import { AgentQueuesFile } from "./agent-queues.ts";
import type { AgentSession } from "./agent-session.ts";
import { AutoReviews } from "./auto-reviews.ts";
import type { CopilotHookOutput } from "./copilot-hook-output.ts";
import { CopilotHookEvent } from "./copilot-hook-record.ts";
import type { LspServer } from "./copilot-plugin.ts";
import { sandboxState, taskSandbox } from "./copilot-sandbox.ts";
import type { EndedTaskFacts } from "./ended-task.ts";
import { HandoffWatch } from "./handoff-watch.ts";
import { appendHookRecord } from "./hook-tail.ts";
import { javaNavigationState } from "./java-language-server.ts";
import { JavaNavigationServers } from "./java-navigation-servers.ts";
import { LAST_SUPERVISOR_FILE, LastSupervisorFile } from "./last-supervisor.ts";
import { ListedSessions } from "./listed-sessions.ts";
import { LiveSession, type SessionEvent, type SessionWindow } from "./live-session.ts";
import { MiseTrustNotices, type TrustRecipient, trustRecipientOf } from "./mise-trust-notices.ts";
import { modelArgs } from "./model-args.ts";
import { proposedByOf, proposerExists, proposerKeyOf, proposerKind, proposerOf } from "./proposer.ts";
import { readRequestPrompt } from "./read-request-prompt.ts";
import {
  PLAIN_START,
  type ResumableSession,
  ResumableSessions,
  resumablePlace,
  type SessionLaunch,
  type SessionStartOptions,
  sessionLaunch,
} from "./resumable-sessions.ts";
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
import { supervisorSituation } from "./supervisor-situation.ts";
import { TaskCoordination } from "./task-coordination.ts";
import { TaskFile } from "./task-file.ts";
import { TaskProposals } from "./task-proposals.ts";
import { TaskReviews } from "./task-reviews.ts";
import { type RoundsVcs, TASK_ROUNDS_FILE, TaskRoundList } from "./task-rounds.ts";
import { AgentTasks, type TaskLaunch, type TaskOptions, type TasksVcs } from "./tasks.ts";

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
export { AUTO_REVIEWS_FILE } from "./auto-reviews.ts";
export { LAST_SUPERVISOR_FILE } from "./last-supervisor.ts";
export { TASK_ROUNDS_FILE } from "./task-rounds.ts";
/** Proposals, reviews, messages and updates that wait, for the next daemon (ADR-115). */
export const AGENT_QUEUES_FILE = "agent-queues.json";
/** Where task worktrees went before ADR-84; tasks from then keep them there until they end. */
export const LEGACY_WORKTREES_DIR = "worktrees";

/** What `agents` needs from `procs`; wired in the facade. */
/** What `#launchAs` adds to a start: for a repo or free session what it started with (ADR-175), for the supervisor its model (ADR-193). */
interface LaunchWithOptions {
  start?: SessionStartOptions;
  /** Before the session's own arguments, as a task's model (ADR-98). */
  args?: readonly string[];
  lspServers?: Record<string, LspServer>;
}

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
  /** `supervisorModel` from `workspace.yaml` (ADR-193): the supervisor's model, `null` for the default; `invalid_config` for a bad key. */
  supervisorModel(): string | null;
  /** `sandbox` from `workspace.yaml` with its default (ADR-181): which tasks run in Copilot CLI's sandbox; `invalid_config` for a bad key. */
  sandboxSettings(): SandboxSettings;
  /** `agentSecrets` from `workspace.yaml` (ADR-93): the secrets from mise a session's tools get; `invalid_config` for a bad key. */
  agentSecrets(): readonly string[];
  /** `autoReview` from `workspace.yaml` (ADR-182): whether a task gets a review once its agent reports; `invalid_config` for a bad key. */
  autoReviewSettings(): AutoReviewSettings;
  /** `sessionProfile` from `workspace.yaml` (ADR-136): the mise environment sessions start with; `invalid_config` for a bad key. */
  sessionProfile(): string | null;
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
  /** Closes the user's folder terminal in a task's worktree before the task ends (`terminals`, ADR-185). */
  closeFolderTerminal: (task: string) => Promise<void>;
  repos: AgentsRepos;
  /** Task worktrees and branches (ADR-31), and the round commits in them (ADR-168). */
  vcs: TasksVcs & RoundsVcs;
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
  /** Opens VS Code on a folder (a task's worktree), or on a file at `line` (a file of a conversation). */
  openEditor: (path: string, line?: number) => void;
  /** Whether a board item is on the board (ADR-133): a task or a proposal names only an existing one. */
  boardHas: (item: string) => Promise<boolean>;
  /** The workspace knowledge the user approved for a session in `repo` (`null`: in the projects folder), ADR-170. */
  knowledge: (repo: string | null) => Promise<SessionKnowledge>;
  /**
   * What each task's work came to, its verification verdict and its merge request with the pipeline (ADR-154), which
   * `verification` and `merge-requests` keep: the supervisor's situation tells it with each task (ADR-156).
   */
  taskOutcomes: () => readonly TaskOutcome[];
  /**
   * A task has ended and its worktree is gone: what other modules keep of it (its logs, ADR-59) can go too, and its
   * facts go to the task journal (ADR-150).
   */
  onTaskRemoved: (ended: EndedTaskFacts) => void;
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
  readonly #rounds: TaskRoundList;
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
  readonly #javaNavigation: JavaNavigationServers;
  readonly #autoReviews: AutoReviews;

  constructor(deps: AgentsDeps) {
    this.#deps = deps;
    this.#javaNavigation = new JavaNavigationServers({
      projectsDir: () => deps.repos.projectsDir(),
      settings: () => deps.repos.javaNavigation(),
      log: deps.log,
    });
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
      change: (task) => this.#tasks.change(task),
      knowledge: deps.knowledge,
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
      // Read at every start, a resume and a restart included, so a change in Settings applies to the next one (ADR-193).
      launch: (spec, place) => this.#launchAs(spec, place, { args: modelArgs(deps.repos.supervisorModel()) }),
      close: (id) => this.#close(id),
    });
    this.#tasks = new AgentTasks({
      vcs: deps.vcs,
      repos: deps.repos,
      file: new TaskFile(join(deps.home, TASKS_FILE), deps.log),
      liveIn: (dir) => deps.procs.liveIn(dir),
      closeFolderTerminal: (task) => deps.closeFolderTerminal(task),
      legacyWorktreesDir: join(deps.home, LEGACY_WORKTREES_DIR),
      roundCommits: (task) => this.#rounds.roundCommits(task),
      openEditor: deps.openEditor,
      log: deps.log,
      javaNavigation: this.#javaNavigation,
      sandbox: async (approvals) => taskSandbox(sandboxState(deps.repos.sandboxSettings(), await deps.env()), approvals),
      sessions: {
        launch: (spec) => this.#launchTask(spec),
        of: (task) => this.#sessions.views().filter((s) => s.task === task),
        close: (id) => this.#close(id),
      },
    });
    this.#rounds = new TaskRoundList({
      vcs: deps.vcs,
      path: join(deps.home, TASK_ROUNDS_FILE),
      task: (id) => this.#tasks.roundTask(id),
      midTurn: (task) => inTurn(this.#sessions.runningOfTask(task)?.view()?.state?.state),
      askToRead: (task) => this.#sessions.runningOfTask(task)?.askToRead(),
      log: deps.log,
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
    this.#autoReviews = new AutoReviews({
      tasks: {
        task: (id) => this.#tasks.task(id),
        hasTask: (id) => this.#tasks.find(id) !== undefined,
        changes: async (id, maxPatchBytes) => {
          const { files, patch, truncated } = await this.#tasks.agentChanges(id, maxPatchBytes, []);
          return { fileCount: files.length, patch, truncated };
        },
      },
      launch: async ({ repo, task }) => {
        const { copilot, mise } = await this.#launcher.inputs({ repo, supervisor: false, task });
        return { program: copilot.program, prefix: copilot.args, env: mise.env, args: mise.args, secrets: mise.secretValues };
      },
      procs: deps.procs,
      settings: () => deps.repos.autoReviewSettings(),
      home: deps.home,
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
    return { sessions, tasks, proposals, messages: this.#coordination.messages(), lastSupervisor, sessionProfile: this.#sessionProfile() };
  }

  /**
   * The profile a session starts with now (ADR-178); `null` while it cannot be read: a bad key, which Settings shows, or
   * `workspace.yaml` locked for a moment on Windows. The session list must come whatever the file does, since the UI, the
   * events and `list_sessions` all depend on it; a session start reads the file again and reports its own error.
   */
  #sessionProfile(): SessionList["sessionProfile"] {
    try {
      return { name: this.#deps.repos.sessionProfile() };
    } catch {
      return null;
    }
  }

  /** One listed session (`not_found` when it does not exist or the user closed it). */
  session(id: string): Session {
    return this.#sessions.view(this.#sessions.get(id));
  }

  /**
   * A repo session in the root of `repo`, or with `repo: null` a free session in the projects folder (ADR-100), with
   * `prompt` as its first message (`--interactive`) when there is one. In a terminal its id is also Copilot CLI's
   * session id, so a restart can resume it (ADR-95); in the conversation view Copilot CLI picks the conversation's id
   * (ADR-107). It runs on `model` and, in a repo, with `javaNavigation` gets jdtls, on every start (ADR-175); it always
   * asks for approvals, since nothing reviews what it changes in the working copy.
   */
  async start(
    repo: string | null,
    prompt?: string,
    { model = null, javaNavigation = false, view = "terminal" }: Partial<SessionStartOptions> & { view?: SessionView } = {},
  ): Promise<Session> {
    if (javaNavigation) this.#assertJavaNavigation(repo, view);
    const id = randomUUID();
    const cwd = repo === null ? await this.#deps.repos.projectsDir() : await this.#deps.repos.repoPath(repo);
    const place = { repo, supervisor: false, cwd, task: null };
    const start = { model, javaNavigation };
    if (view === "conversation") return this.#launchWithOptions({ view, id, load: undefined, firstMessage: prompt }, place, start);
    const args = [`--session-id=${id}`, ...(prompt === undefined ? [] : [`--interactive=${prompt}`])];
    const started = prompt !== undefined;
    const spec = { view, id, args, promptOnStart: started, hasConversation: started, conversation: id };
    return this.#launchWithOptions(spec, place, start);
  }

  /** Java navigation needs a repo's build, besides what any start with it needs; refused before the start. */
  #assertJavaNavigation(repo: string | null, view: SessionView): void {
    if (repo === null) throw new DomainError("bad_request", "Java navigation needs a repo; a free session cannot get it");
    this.#javaNavigation.assertCanStart(view, "a session");
  }

  /**
   * A repo or free session's start in either view with what it started with (ADR-175): the model on every start, and
   * jdtls in a terminal under the session's id, so a restart starts it warm. A start whose settings broke since starts
   * without jdtls and logs why.
   */
  async #launchWithOptions(spec: SessionLaunch, place: SessionPlace, start: SessionStartOptions): Promise<Session> {
    // Before the session's own arguments, as a task's (ADR-98).
    const args = modelArgs(start.model);
    // Only a hand-edited `resumable-sessions.json` gets here with Java navigation in the conversation view.
    if (spec.view === "conversation" && start.javaNavigation)
      this.#deps.log(`session ${spec.id} starts without Java navigation: it needs a terminal`);
    const wantsServer = spec.view === "terminal" && start.javaNavigation;
    const lspServers = wantsServer ? await this.#javaNavigation.servers(spec.id, place.cwd, `session ${spec.id}`) : {};
    return this.#launchAs(spec, place, { start, args, lspServers });
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
    return this.#proposals.add({ kind: "task", ...proposal, parts: null, proposedBy });
  }

  /**
   * A proposed change from session `caller` (ADR-171): one proposal for all its parts, every repo in the projects folder.
   * A task session proposes work in other repos as subtasks (`propose_task`), which read its handoff: a change would
   * start beside it, on another branch, while the parts' handoffs run from part to part.
   */
  async proposeChange(
    caller: string | null,
    { parts, ...proposal }: Pick<TaskProposal, "title" | "prompt" | "model" | "approvals" | "item"> & { parts: ChangePart[] },
  ): Promise<TaskProposal> {
    const session = caller === null ? null : this.session(caller);
    if (session?.task != null)
      throw new DomainError(
        "bad_request",
        "a task proposes the work in other repos with propose_task, one proposal per repo, so that each reads your handoff",
      );
    for (const { repo } of parts) await this.#deps.repos.repoPath(repo);
    await this.#assertOnBoard(proposal.item);
    const [first] = parts;
    if (first === undefined) throw new Error("a change has parts");
    return this.#proposals.add({ kind: "change", repo: first.repo, ...proposal, parts, proposedBy: proposedByOf(session) });
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
        parts: null,
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
      return await this.#tasks.create(repo, prompt, {
        id,
        title,
        proposedBy,
        model,
        approvals,
        javaNavigation: false,
        item,
        view,
        change: null,
      });
    } finally {
      this.#proposals.release(id, this.#tasks.find(id) === undefined);
    }
  }

  /**
   * A change from a proposal (ADR-171): `createChange` with the parts the user kept, in the proposal's order, and the
   * options and notes as the user left them; the first part made takes the proposal's id and every part its proposer. The proposal waits again only when
   * no part started; otherwise it is gone, and its proposer hears which parts started.
   */
  async approveChangeProposal(id: string, { prompt, parts, model, approvals, view }: ApproveChangeRequest): Promise<CreatedChange> {
    const proposal = this.#proposals.get(id);
    if (proposal.parts === null) throw new DomainError("bad_request", `proposal ${id} is not a change`);
    const proposed = proposalRepos(proposal);
    const unknown = parts.filter((part) => !proposed.includes(part.repo)).map((part) => part.repo);
    if (unknown.length > 0) throw new DomainError("bad_request", `${unknown.join(", ")} is not a part of the proposed change`);
    // The proposal's order, which the user approved; the notes as the user left them.
    const kept = proposed.flatMap((repo) => parts.filter((part) => part.repo === repo));
    if (!changePromptsFit(prompt, kept)) throw new DomainError("bad_request", CHANGE_PROMPTS_TOO_LONG);
    const { title, proposedBy, item } = this.#proposals.take(id);
    const prompts = kept.map((part) => ({ repo: part.repo, prompt: changePartPrompt(prompt, part) }));
    let created: CreatedChange;
    try {
      created = await this.#tasks.createChange(prompts, { title, proposedBy, model, approvals, javaNavigation: false, item, view }, id);
    } catch (err) {
      this.#proposals.release(id, true);
      throw err;
    }
    this.#proposals.release(id, false);
    this.#coordination.changeStarted(id, proposedBy, created);
    return created;
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
    if (this.#proposals.list().some((p) => proposalRepos(p).includes(proposal.repo) && this.#proposals.approving(p.id)))
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
      if (proposalRepos(other).includes(proposal.repo) && this.#proposals.find(other.id))
        this.rejectProposal(other.id, `${proposal.repo} was removed from the projects folder`);
  }

  #assertNothingRunsIn(repo: string, repoDir: string): void {
    const sessions = this.#sessions.views().filter((s) => s.repo === repo && s.task === null && s.run.kind !== "exited");
    if (sessions.length > 0) throw new DomainError("bad_request", `stop the sessions in ${repo} first (${sessions.length} running)`);
    if (this.#tasks.creatingIn(repo)) throw new DomainError("bad_request", `a task of ${repo} is being created; wait for it, then end it`);
    const tasks = this.#tasks.list().filter((t) => t.repo === repo);
    if (tasks.length > 0)
      throw new DomainError("bad_request", `end the tasks of ${repo} first (${tasks.length}): their worktrees belong to the repo`);
    if (this.#deps.procs.liveIn(repoDir))
      throw new DomainError("bad_request", `stop the mise tasks, services and terminals running in ${repo} first`);
  }

  rejectProposal(id: string, reason: string | undefined): void {
    const proposal = this.#proposals.get(id);
    this.#proposals.reject(id, reason ?? null);
    this.#coordination.proposalRejected(proposal, reason ?? null);
  }

  /** A summary from session `caller` for its own task (`report_result`); it goes to the task's proposer too (ADR-68). */
  reportSummary(caller: string | null, text: string, checkSteps: string[]): Task {
    const own = this.#ownTask(caller, "can report a result");
    const reported = this.#tasks.setSummary(own.task, text, checkSteps);
    this.#coordination.resultReported(reported, own.session);
    this.#autoReviews.afterReport(own.task);
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
  #readRequestPrompt(session: { id: string; supervisor: boolean; task: string | null }): string | undefined {
    const reviewComments = session.task === null ? 0 : this.#reviews.unread(session.task);
    return readRequestPrompt({
      reviewComments,
      handoffMoved: session.task !== null && this.#handoffs.waiting(session.task),
      roundUndone: session.task !== null && this.#rounds.undoneUntold(session.task),
      ...this.#coordination.unread(session),
      trustNotice: this.#miseTrust.waiting(trustRecipientOf(session)),
    });
  }

  /** The unread review comments of session `caller`'s own task (`get_review_comments`), which now count as read. */
  takeReviewComments(caller: string | null): ReviewComment[] {
    return this.#reviews.take(this.#ownTask(caller, "has review comments").task);
  }

  /**
   * A message from session `caller` to the session of a task it proposed (`send_message`, ADR-68); the task's agent
   * reads it with `get_messages`.
   */
  sendMessage(caller: string | null, task: string, text: string): SendMessageResult {
    return this.#coordination.send(caller, task, text);
  }

  /** A question from session `caller`'s own task to the task's proposer (`ask_proposer`, ADR-160). */
  askProposer(caller: string | null, text: string): PromptDelivery {
    const own = this.#ownTask(caller, "has a proposer to ask");
    return this.#coordination.ask(own.task, own.session, text);
  }

  /** The unread messages to session `caller`'s own task (`get_messages`), which now count as read. */
  takeMessages(caller: string | null): TaskMessage[] {
    return this.#coordination.takeMessages(this.#ownTask(caller, "gets messages").task);
  }

  /** Where the work session `caller`'s own task builds on is now (`get_handoff`, ADR-144), whose head now counts as read. */
  async readHandoff(caller: string | null): Promise<TaskHandoffState | null> {
    return this.#handoffs.read(this.#ownTask(caller, "has a handoff").task);
  }

  /** Session `caller` and the task it runs, for a tool only a task's session has: `bad_request` "only a session that runs a task in Trackwall <what>" otherwise. */
  #ownTask(caller: string | null, what: string): { session: string; task: string } {
    const task = caller === null ? null : this.session(caller).task;
    if (caller === null || task === null) throw new DomainError("bad_request", `only a session that runs a task in Trackwall ${what}`);
    return { session: caller, task };
  }

  /** The unread updates on the work session `caller` delegated (`get_updates`), which now count as read. */
  takeUpdates(caller: string | null): { updates: TaskUpdate[]; dropped: number } {
    return this.#coordination.takeUpdates(caller);
  }

  /** A task's verification has its verdict (ADR-64), which goes to the task's proposer (ADR-68). */
  verificationFinished(verification: Verification): void {
    this.#coordination.verificationFinished(verification);
  }

  /** The pipeline of the merge request from a task's branch failed (ADR-154): the task's proposer hears of it. */
  pipelineFailed(task: string, mergeRequest: MergeRequest): void {
    this.#coordination.pipelineFailed(task, mergeRequest);
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
   * (ADR-137). With `handoffFrom` the user hands it the work of that task (ADR-147): it becomes that task's subtask,
   * which reads its change and reports to it as if its session had proposed it (ADR-140, ADR-143). A task run from a
   * routine (ADR-173) has the routine's `title`; a typed one has none.
   */
  async createTask(
    repo: string,
    prompt: string,
    {
      approvals = "ask",
      model = null,
      javaNavigation = false,
      item = null,
      view = "terminal",
      title = null,
    }: Partial<TaskOptions> & { title?: string | null } = {},
    handoffFrom: string | null = null,
  ): Promise<Task> {
    await this.#assertOnBoard(item);
    // `task` throws `not_found` for a task that is not on the list, before a worktree exists.
    const proposedBy = handoffFrom === null ? null : { session: null, supervisor: false, task: this.task(handoffFrom).id };
    const origin = { id: randomUUID(), title, proposedBy, model, approvals, javaNavigation, item, view, change: null };
    return this.#tasks.create(repo, prompt, origin);
  }

  /** A change the user typed (ADR-171): a task per part, see `AgentTasks.createChange`; `item` must be on the board. */
  async createChange({ title, prompt, parts, approvals, model, item, view }: ChangeRequest): Promise<CreatedChange> {
    await this.#assertOnBoard(item);
    const prompts = parts.map((part) => ({ repo: part.repo, prompt: changePartPrompt(prompt, part) }));
    return this.#tasks.createChange(prompts, { title, proposedBy: null, model, approvals, javaNavigation: false, item, view });
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

  /**
   * What the New session form offers on this computer: whether Java navigation can start now, or why not (ADR-99), and
   * which tasks run in Copilot CLI's sandbox and whether it can run here (ADR-181).
   */
  async startOptions(): Promise<StartOptions> {
    return { javaNavigation: this.javaNavigationState(), sandbox: await this.sandboxState() };
  }

  /** Which tasks run in Copilot CLI's sandbox, and why it cannot run here (ADR-181); `invalid_config` for a bad `sandbox` key. */
  async sandboxState(): Promise<SandboxState> {
    return sandboxState(this.#deps.repos.sandboxSettings(), await this.#deps.env());
  }

  /** Whether Java navigation can start now, or why not (ADR-99); `null` without `javaNavigation` in `workspace.yaml`. */
  javaNavigationState(): JavaNavigationState {
    return javaNavigationState(this.#javaNavigation.readiness());
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

  /** Every task until it ends. */
  tasks(): Task[] {
    return this.#tasks.list();
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

  /** The task's rounds and whether its newest one can be undone now (ADR-168). */
  taskRounds(id: string): Promise<TaskRounds> {
    return this.#rounds.list(id);
  }

  /** One round's files and diff (ADR-168). */
  taskRoundChanges(id: string, round: number): Promise<WorkingTreeChanges> {
    return this.#rounds.changes(id, round);
  }

  /** The user undoes the task's newest standing round (ADR-168); its agent hears of it. Only from the UI. */
  undoTaskRound(id: string, round: number): Promise<TaskRounds> {
    return this.#rounds.undo(id, round);
  }

  /** The user's push of the task branch, with the round commits the remote does not have yet squashed (ADR-168). */
  pushWithRoundsSquashed(id: string, push: (source: string | undefined) => Promise<void>): Promise<void> {
    return this.#rounds.pushWithRoundsSquashed(id, push);
  }

  /** The user's automatic review of a task's changes (ADR-182), or the one running. */
  startAutoReview(id: string): Promise<AutoReview> {
    return this.#autoReviews.start(id);
  }

  /** The task's last automatic review (ADR-182); `null` without one. */
  autoReview(id: string): AutoReview | null {
    return this.#autoReviews.get(id);
  }

  /** Stops the task's running automatic review (ADR-182). */
  cancelAutoReview(id: string): Promise<AutoReview | null> {
    return this.#autoReviews.cancel(id);
  }

  /** Other tasks of the same repo that change the same files (ADR-44). */
  taskSharedFiles(id: string): Promise<TaskSharedFiles[]> {
    return this.#tasks.sharedFiles(id);
  }

  /** How the task's Java language server is doing (ADR-124); `null` for a task without Java navigation. */
  taskJavaNavigation(id: string): Promise<JavaNavigationStatus | null> {
    return this.#tasks.javaNavigationStatus(id);
  }

  /** How a session's jdtls is doing: its task's, or a repo session's own (ADR-175); `null` without Java navigation. */
  async sessionJavaNavigation(id: string): Promise<JavaNavigationStatus | null> {
    const session = this.#sessions.get(id);
    if (session.task !== null) return this.#tasks.javaNavigationStatus(session.task);
    if (!this.#sessions.startOf(id).javaNavigation) return null;
    const view = this.#sessions.view(session);
    return this.#javaNavigation.status(id, view.run.kind === "exited" ? null : new Date(view.startedAt));
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

  /** A file of a session's conversation in VS Code at `line` (ADR-107), only inside the session's working directory. */
  openConversationFile(id: string, path: string, line: number): void {
    this.#deps.openEditor(this.#conversationOf(id).fileOf(path), line);
  }

  /**
   * The user hands a task they started to the supervisor (ADR-155): from then on its updates go to the supervisor, which
   * may send it messages, and the supervisor is told at once.
   */
  handToSupervisor(id: string): Task {
    const task = this.#tasks.handToSupervisor(id);
    this.#coordination.taskHanded(task);
    return task;
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
  /** The worktree of task `id` of `repo` for the user's shell (ADR-185); refused while the task is being ended. */
  taskWorktreeForShell(id: string, repo: string): string {
    return this.#tasks.worktreeForShell(id, repo);
  }

  trustedTaskWorktree(id: string, repo: string): Promise<{ worktree: string; port: number }> {
    return this.#tasks.trustedWorktree(id, repo);
  }

  async removeTask(id: string, keepBranch: boolean, discardChanges: boolean): Promise<void> {
    // Its reviewer runs in the worktree, which the removal refuses while a process of Trackwall is in it. Without one,
    // the removal starts at once, so a change computation that comes after it refuses.
    const stopping = this.#autoReviews.stop(id);
    if (stopping !== null) await stopping;
    const ended = await this.#tasks.remove(id, keepBranch, discardChanges);
    this.#autoReviews.forget(id);
    this.#reviews.take(id);
    this.#miseTrust.forget({ task: id });
    this.#handoffs.forget(id);
    this.#rounds.forget(id);
    this.#coordination.taskEnded(id);
    this.#deps.onTaskRemoved(ended);
  }

  /** A start in a terminal; a new id by default, and for a repo or free session what it started with (ADR-175). */
  async #launch({ id = randomUUID(), ...spec }: Omit<TerminalLaunch, "id"> & { id?: string }, start = PLAIN_START): Promise<Session> {
    this.#assertNotListed(id);
    return this.#listed(await this.#launcher.terminal({ id, ...spec }), start);
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
  #listed({ session, miseEnv, mise }: StartedSession, start = PLAIN_START): Session {
    this.#sessions.add({ session, miseEnv, mise }, start);
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
   * (ADR-95): a task's session as Resume does, the supervisor, a free session and a repo session under their id. The
   * new start reads the environment, `agentSecrets` and tool permissions again. A repo or free session gives up its
   * place in the list before the start, since an id is listed once, so a failed start leaves it out of the list;
   * Copilot CLI still keeps its conversation.
   */
  async restart(id: string): Promise<Session> {
    const session = this.#sessions.get(id);
    if (this.#restarting.has(id)) throw new DomainError("bad_request", "the session is already restarting");
    if (!this.#sessions.isRunning(session)) throw new DomainError("bad_request", "the session has ended; start it again instead");
    const { supervisor, task } = session;
    const left = this.#sessions.resumable(session);
    this.#restarting.add(id);
    try {
      // What can refuse the start (a bad name in `agentSecrets`, a bad `supervisorModel`, Copilot CLI gone) refuses it before the stop, so the
      // session goes on as it was.
      await this.#launcher.inputs(session);
      if (supervisor) this.#deps.repos.supervisorModel();
      // The user may have stopped or closed the session meanwhile: it is not started again behind their back.
      if (this.#sessions.find(id) !== session || !this.#sessions.isRunning(session))
        throw new DomainError("bad_request", "the session has ended; start it again instead");
      await this.#deps.procs.stop(sessionOwner(id));
      if (task === null && !supervisor) this.#unlist(session);
      return await this.#resumeLeft(left).catch(async (err: unknown) => {
        // Out of the list, it can never be closed, so its jdtls index goes now (ADR-175).
        if (left.javaNavigation) await this.#javaNavigation.remove(id, `session ${id}`);
        throw err;
      });
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

  /** The user's Deliver now for what waits unread for a running session's agent (ADR-159). */
  deliverReadRequest(id: string): Session {
    const session = this.#sessions.get(id);
    if (!this.#sessions.isRunning(session)) throw new DomainError("bad_request", "the session has ended");
    session.deliverNow();
    return this.#sessions.view(session);
  }

  /**
   * Text session `caller`'s agent asks to put on the user's clipboard (`copy_to_clipboard`, ADR-180): it waits in the
   * session's panel until the user copies it there. The daemon never writes a clipboard: in a container it has none of
   * the user's, and an agent must not change what the user pastes without a click.
   */
  askToCopy(caller: string | null, text: string): void {
    const session = caller === null ? undefined : this.#sessions.find(caller);
    if (session === undefined || !this.#sessions.isRunning(session))
      throw new DomainError("bad_request", "only a running session in Trackwall can ask to copy; give the user the text in your answer");
    session.copyRequest.ask(text);
  }

  /** The user copied or dismissed the copy request `request` of session `id` (ADR-180). */
  clearCopyRequest(id: string, request: string): Session {
    const session = this.#sessions.get(id);
    session.copyRequest.clear(request);
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
  say(id: string, text: string, attachments: readonly MessageAttachment[] = []): Session {
    const session = this.#conversationOf(id);
    if (!this.#sessions.isRunning(session)) throw new DomainError("bad_request", "the session is no longer running");
    session.say(text, attachments);
    return this.#sessions.view(session);
  }

  /** Stops the turn of a session in the conversation view (ADR-107). */
  interrupt(id: string): Session {
    const session = this.#conversationOf(id);
    session.interrupt();
    return this.#sessions.view(session);
  }

  /** Switches the agent of a session in the conversation view to one of the modes it offers (ADR-107). */
  async setMode(id: string, mode: string): Promise<Session> {
    const session = this.#conversationOf(id);
    if (!this.#sessions.isRunning(session)) throw new DomainError("bad_request", "the session is no longer running");
    await session.setMode(mode);
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
   * supervisor, a free session and a repo session start again under their id with `--resume`. One that cannot (its task
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
        if (session.task === null) await this.#forgetLeftMain(session);
      }
    }
  }

  /**
   * A supervisor, free or repo session that did not start again and is out of the list: what waited for it has nobody
   * to reach, as when the user closes a session (ADR-115), and its jdtls index nobody to use (ADR-175).
   */
  async #forgetLeftMain({ session: id, supervisor, javaNavigation }: ResumableSession): Promise<void> {
    this.#coordination.sessionClosed({ id, supervisor, task: null });
    if (javaNavigation) await this.#javaNavigation.remove(id, `session ${id}`);
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
    const { model, javaNavigation } = left;
    const started = await this.#launchWithOptions(spec, { repo, supervisor: false, cwd, task: null }, { model, javaNavigation });
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
    if (session !== undefined && this.#readRequestPrompt(session) !== undefined) session.askToRead();
  }

  /**
   * A start in the view it names, in `place`; for a repo or free session with what it started with (ADR-175): `args` go before
   * the session's own, and `lspServers` only into a terminal's plugin.
   */
  async #launchAs(
    spec: SessionLaunch,
    place: SessionPlace,
    { start = PLAIN_START, args = [], lspServers = {} }: LaunchWithOptions = {},
  ): Promise<Session> {
    if (spec.view === "terminal") return this.#launch({ ...spec, ...place, args: [...args, ...spec.args], lspServers }, start);
    this.#assertNotListed(spec.id);
    return this.#listed(await this.#launcher.conversation({ ...spec, ...place, args }), start);
  }

  /** An id is listed once: a start under a listed id is a bug in the caller, caught before anything is issued for it. */
  #assertNotListed(id: string): void {
    if (this.#sessions.has(id)) throw new Error(`session ${id} is already listed`);
  }

  /**
   * Daemon exit, before `procs.stopAll`: the sessions it stops stay in the list for the next daemon to resume (ADR-95),
   * the queues stay as they are now (ADR-115), with the user's latest typing in them, and so do the automatic reviews (ADR-182).
   */
  keepRunningSessionsForResume(): void {
    this.#autoReviews.keepForRestart();
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
    const { javaNavigation } = this.#sessions.startOf(id);
    this.#unlist(session);
    this.#coordination.sessionClosed(session);
    // A repo session's jdtls index lasts while the session does (ADR-175).
    if (javaNavigation) void this.#javaNavigation.remove(id, `session ${id}`);
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
      prompt: () => this.#readRequestPrompt({ id, supervisor, task }),
      situation: () => (supervisor ? supervisorSituation(this.sessionsWithoutCycle(), id, this.#deps.taskOutcomes()) : undefined),
      onUserText: () => this.#coordination.userTyped({ id, task }),
      onPromptSent: () => {
        this.#miseTrust.promptSent(trustRecipientOf({ id, task }));
        if (task !== null) this.#rounds.promptSent(task);
      },
      onTurnStart: () => {
        if (task !== null) void this.#rounds.turnStarted(task);
      },
      onTurnOver: () => {
        // The round commit first: it moves the branch, which the tasks it handed work to then hear about (ADR-144).
        if (task !== null) void this.#rounds.turnOver(task).then(() => this.#handoffs.turnOver(task));
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
