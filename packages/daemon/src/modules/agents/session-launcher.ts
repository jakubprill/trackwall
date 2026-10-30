import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copilotHttpMcpServers,
  type HttpEndpoint,
  type RunState,
  type Session,
  type SupervisorSettings,
  type ToolPermissions,
} from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { AcpSession } from "./acp-session.ts";
import type { AgentSession } from "./agent-session.ts";
import { resolveCopilot, toolPermissionArgs } from "./copilot-command.ts";
import type { CopilotHookEvent } from "./copilot-hook-record.ts";
import { type LspServer, writeCopilotPlugin } from "./copilot-plugin.ts";
import { LiveSession, type LiveSessionOptions, type SessionPty } from "./live-session.ts";
import { withLoopbackNoProxy } from "./no-proxy.ts";
import type { ConversationLaunch } from "./resumable-sessions.ts";
import { type SessionMiseEnv, type SessionMiseLaunch, sessionMiseLaunch } from "./session-env.ts";
import { type SessionRole, withInstructionsDir, writeSessionInstructions } from "./session-instructions.ts";
import type { SessionTokens } from "./session-tokens.ts";

/**
 * How a session of either view starts (§4.4, ADR-26, ADR-107): Copilot CLI found on the user's `PATH`, the session
 * directory with its MCP config, instructions and (in a terminal) the session plugin, the session token, the arguments
 * and the environment from mise, and the process group in `procs`. The daemon builds the whole command; only the place
 * comes from outside (§1.2). A start that fails once its directory and token exist leaves nothing behind: no process
 * group, no token, no directory. What a started session does next (the list, the tick, the coordination) is `Agents`'s.
 */

/** The PTY size before a session terminal reports its own. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;
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

/** The directory of all session directories in the state directory; sessions do not outlive the daemon. */
export function sessionsDir(home: string): string {
  return join(home, SESSIONS_DIR);
}

/** A session's directory in the state directory: its plugin, MCP configuration, token and hook records. */
export function sessionDir(home: string, id: string): string {
  return join(sessionsDir(home), id);
}

/** A session's MCP configuration, which names the Trackwall server with the session's tokens (ADR-39, ADR-89). */
export function sessionMcpConfigFile(home: string, id: string): string {
  return join(sessionDir(home, id), MCP_CONFIG_FILE);
}

/** A session's `hooks.jsonl`. */
export function sessionHooksFile(home: string, id: string): string {
  return join(sessionDir(home, id), HOOKS_FILENAME);
}

/** The group owner key of a session in `procs`; only ever built, never taken apart again. */
export function sessionOwner(id: string): string {
  return `agent:${id}`;
}

/** What a start needs from `procs`. */
export interface LauncherProcs {
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
}

/** What a start reads of the workspace configuration, each of which can refuse it. */
interface LauncherRepos {
  toolPermissions(session: Pick<Session, "repo" | "supervisor">): ToolPermissions;
  supervisorSettings(): SupervisorSettings;
  agentSecrets(): readonly string[];
}

/** How a session of either view tells `Agents` what it did. */
export type SessionCallbacks = Pick<LiveSessionOptions, "prompt" | "onUserText" | "onPromptSent" | "onEvent">;

export interface SessionLauncherDeps {
  procs: LauncherProcs;
  repos: LauncherRepos;
  home: string;
  copilot: readonly string[];
  version: string;
  env: () => Promise<NodeJS.ProcessEnv>;
  miseEnv: (place: { repo: string | null; task: string | null }) => Promise<SessionMiseEnv>;
  sessionHook: (event: CopilotHookEvent, sessionToken: string) => HttpEndpoint;
  sessionMcpServer: (sessionToken: string) => HttpEndpoint;
  tokens: SessionTokens;
  callbacks: (session: { id: string; supervisor: boolean; task: string | null }) => SessionCallbacks;
  log: (msg: string) => void;
}

/** A session whose process started, with the environment it started with (ADR-119). */
export interface StartedSession {
  session: AgentSession;
  /** What mise gave the place, which the session's environment is compared with later. */
  miseEnv: SessionMiseEnv;
  mise: SessionMiseLaunch;
}

export class SessionLauncher {
  readonly #deps: SessionLauncherDeps;

  constructor(deps: SessionLauncherDeps) {
    this.#deps = deps;
  }

  /**
   * Copilot CLI in a terminal in `cwd` (the repo root or the worktree of task `task`) with arguments before the session's
   * arguments; `promptOnStart` when the arguments carry the first message (`--interactive`), so the session works from the start.
   */
  terminal({ id, args, promptOnStart, hasConversation, conversation, lspServers = {}, ...place }: TerminalLaunch): Promise<StartedSession> {
    return this.#start(id, place, (setup) => {
      const { session, instructionsDir } = this.#prepare({
        id,
        ...place,
        role: setup.role,
        dir: setup.dir,
        token: setup.token,
        promptOnStart,
        hasConversation,
        conversation,
        program: setup.program,
        environment: setup.mise.environment,
        lspServers,
      });
      const start = async () => {
        const { terminal } = await this.#deps.procs.startTerminal({
          owner: sessionOwner(id),
          command: [setup.program, ...setup.prefix, "--plugin-dir", join(setup.dir, "plugin"), ...setup.args, ...args],
          cwd: place.cwd,
          env: sessionEnv(setup.env, instructionsDir),
          secrets: setup.mise.secretValues,
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
          onData: (bytes) => session.output(bytes),
        });
        session.connect(terminal);
      };
      return { session, start };
    });
  }

  /**
   * Copilot CLI over ACP (ADR-107) in `cwd`: the same MCP server, instructions, tool permissions and mise environment as
   * in a terminal, without the session plugin, since the protocol itself says what the session does.
   */
  conversation({ id, load, firstMessage, ...place }: ConversationLaunch & SessionPlace): Promise<StartedSession> {
    const { repo, supervisor, task, cwd } = place;
    return this.#start(id, place, (setup) => {
      const instructionsDir = this.#writeSessionFiles(id, setup.role, setup.dir, setup.token);
      const session = new AcpSession({
        id,
        repo,
        supervisor,
        task,
        cwd,
        load,
        firstMessage,
        environment: setup.mise.environment,
        run: () => this.#deps.procs.state(sessionOwner(id)),
        ...this.#deps.callbacks({ id, supervisor, task }),
        log: this.#deps.log,
      });
      const start = async () => {
        const { channel } = await this.#deps.procs.startChannel({
          owner: sessionOwner(id),
          command: [setup.program, ...setup.prefix, "--acp", ...setup.args],
          cwd,
          env: sessionEnv(setup.env, instructionsDir),
          secrets: setup.mise.secretValues,
          onStdout: (chunk) => session.output(chunk),
        });
        session.connect(channel);
        await session.start();
      };
      return { session, start };
    });
  }

  /**
   * What a start reads of the configuration, each of which can refuse it: Copilot CLI, the tool permissions and what
   * mise gives the place with the agent secrets (ADR-93). A restart reads it before it stops the session (ADR-119).
   */
  async inputs({ repo, supervisor, task }: Pick<SessionPlace, "repo" | "supervisor" | "task">) {
    const userEnv = await this.#deps.env();
    // The user's `PATH`, not mise's: a mise config an agent can change must not choose the program that gets every secret.
    const copilot = resolveCopilot(this.#deps.copilot, userEnv);
    if ("missing" in copilot) throw new DomainError("agent_unavailable", copilot.message);
    const permissions = this.#deps.repos.toolPermissions({ repo, supervisor });
    return { copilot, permissions, ...(await this.#miseLaunch({ repo, task }, userEnv)) };
  }

  /** What mise would give a session in its place now (ADR-93, ADR-119). */
  async mise(place: { repo: string | null; task: string | null }) {
    return this.#miseLaunch(place, await this.#deps.env());
  }

  /**
   * A start of either view on what `#setUp` gives it: `open` writes the session's files and makes the session, its
   * `start` starts the process. Whatever step fails, nothing is left behind: the process group is stopped (an ACP
   * session can fail after its process started, in the handshake), the token revoked and the session directory removed.
   * A failed process start is the repo's error (`domainError`); a failed write of the session's files is thrown as it is.
   */
  async #start(id: string, place: SessionPlace, open: (setup: SessionSetup) => OpenedSession): Promise<StartedSession> {
    const setup = await this.#setUp(id, place);
    let opened: OpenedSession | undefined;
    try {
      opened = open(setup);
      await opened.start();
    } catch (err) {
      await this.#deps.procs.stop(sessionOwner(id)).catch(() => undefined);
      this.#deps.tokens.revoke(id);
      opened?.session.dispose();
      rmSync(setup.dir, { recursive: true, force: true });
      throw opened === undefined ? err : domainError(place.repo, err);
    }
    return { session: opened.session, miseEnv: setup.miseEnv, mise: setup.mise };
  }

  /** What every start needs: Copilot CLI, the session directory and token, and the arguments and environment it gets. */
  async #setUp(id: string, place: SessionPlace): Promise<SessionSetup> {
    const { repo, supervisor, task } = place;
    const { copilot, permissions, miseEnv, mise } = await this.inputs(place);
    // The MCP server and the hooks are the daemon on `127.0.0.1`, which a proxy of the user must not get (ADR-89).
    const env = withLoopbackNoProxy({ ...mise.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...LOOPBACK_HOOKS_ENV });
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
      token: this.#deps.tokens.issue(id),
    };
  }

  async #miseLaunch(place: { repo: string | null; task: string | null }, userEnv: NodeJS.ProcessEnv) {
    const miseEnv = await this.#deps.miseEnv(place);
    return { miseEnv, mise: sessionMiseLaunch(miseEnv, userEnv, this.#deps.repos.agentSecrets()) };
  }

  #role(repo: string | null, supervisor: boolean, task: string | null): SessionRole {
    if (repo !== null) return { kind: "repo", repo, task };
    return supervisor ? { kind: "supervisor", changesCode: this.#deps.repos.supervisorSettings().changesCode } : { kind: "free" };
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
    lspServers,
  }: SessionFiles): PreparedSession {
    const supervisor = role.kind === "supervisor";
    const hooksFile = join(dir, HOOKS_FILENAME);
    const instructionsDir = this.#writeSessionFiles(id, role, dir, token);
    writeFileSync(hooksFile, "");
    writeCopilotPlugin(join(dir, "plugin"), (event) => ({ type: "http", ...this.#deps.sessionHook(event, token) }), lspServers);
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
      run: () => this.#deps.procs.state(sessionOwner(id)),
      ...this.#deps.callbacks({ id, supervisor, task }),
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
}

/** Where a session runs and what it is. */
export interface SessionPlace {
  /** `null` in the projects folder. */
  repo: string | null;
  supervisor: boolean;
  cwd: string;
  task: string | null;
}

/**
 * A start in a terminal: Copilot CLI in a repo root, in a task's worktree, or the supervisor or a free session in the
 * projects folder.
 */
export interface TerminalLaunch extends SessionPlace {
  id: string;
  /** Copilot CLI already keeps a conversation under the id: the arguments carry the first message or resume it (ADR-95). */
  hasConversation: boolean;
  /** Copilot CLI's id of the conversation when it is not the session id (ADR-107). */
  conversation?: string;
  args: readonly string[];
  promptOnStart: boolean;
  /** The language servers of the session's `lsp` tool (ADR-99); none by default. */
  lspServers?: Record<string, LspServer>;
}

/** What `#setUp` gives a start of either view. */
interface SessionSetup {
  program: string;
  /** Arguments of the program before Copilot CLI's own (`node <copilot>.js`). */
  prefix: readonly string[];
  /** The MCP config, tool permissions and mise's arguments. */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  mise: SessionMiseLaunch;
  miseEnv: SessionMiseEnv;
  role: SessionRole;
  dir: string;
  token: string;
}

/** The directory of a new session and what follows from it for `LiveSession`. */
interface SessionFiles
  extends Pick<LiveSessionOptions, "id" | "repo" | "task" | "promptOnStart" | "hasConversation" | "program" | "environment"> {
  role: SessionRole;
  dir: string;
  token: string;
  conversation: string | undefined;
  lspServers: Record<string, LspServer>;
}

/** A session of either view whose files are written, and the start of its process. */
interface OpenedSession {
  session: AgentSession;
  start: () => Promise<void>;
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

function domainError(repo: string | null, err: unknown): unknown {
  if (!(err instanceof SpawnFailure)) return err;
  const place = repo ?? "the projects folder";
  return new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "agent_unavailable", `${place}: ${err.message}`);
}
