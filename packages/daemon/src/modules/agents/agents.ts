import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copilotMcpServers,
  isSupervisor,
  type RunState,
  type Session,
  type SessionList,
  type Task,
  type TaskChanges,
  type TaskChangesSummary,
  type TaskProposal,
  type TaskSharedFiles,
} from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { findCopilot } from "./copilot-command.ts";
import type { CopilotHookEvent } from "./copilot-hook-record.ts";
import { type HookCommand, writeCopilotPlugin } from "./copilot-plugin.ts";
import { LiveSession, type SessionPty, type SessionWindow } from "./live-session.ts";
import { withInstructionsDir, writeSessionInstructions } from "./session-instructions.ts";
import { SessionTokens } from "./session-tokens.ts";
import { outcome, sessionWaitStatus, type WaitOutcome, waitUntilSettled } from "./session-wait.ts";
import { TaskFile } from "./task-file.ts";
import { TaskProposals } from "./task-proposals.ts";
import { AgentTasks, type TasksVcs } from "./tasks.ts";
import type { ScreenViewer } from "./terminal-screen.ts";

/**
 * Moduł `agents` (§4.4, ADR-26): sesje Copilot CLI uruchamiane z UI w repo z folderu z projektami, kilka naraz.
 * Każda sesja to Copilot CLI w PTY należącym do daemona, w grupie procesów modułu `procs`, z wtyczką sesji, której
 * hooki zgłaszają stan (ADR-17). Komendę składa daemon; z zewnątrz przychodzi tylko identyfikator repo (§1.2).
 * Sesje żyją w pamięci daemona: wyjście daemona zatrzymuje je razem z innymi grupami procesów. Sesja może należeć
 * do zadania (ADR-31, `tasks.ts`): działa wtedy w worktree zadania, a zadanie przeżywa daemona. Sesja może też
 * proponować zadania, zgłaszać podsumowanie swojego zadania i czekać na inną sesję (ADR-39): serwer MCP poznaje ją
 * po tokenie sesji, a zadanie z propozycji startuje dopiero po zatwierdzeniu przez użytkownika. One session, the
 * supervisor (ADR-58), runs in the projects folder instead of a repo, above all the others.
 */

/** Rozmiar PTY, zanim okno terminala zgłosi swój. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;
/** Jak często sesje czytają rekordy hooków i sprawdzają koniec procesu. */
const TICK_MS = 200;
/** Konfiguracja MCP sesji w katalogu sesji; plik zamiast JSON w argumencie, żeby cudzysłowy JSON-u nie zależały od cytowania argumentów na Windowsie. */
const MCP_CONFIG_FILE = "mcp-config.json";
/** Token sesji w katalogu sesji, który most stdio sesji czyta i wysyła do serwera MCP (ADR-39). */
const SESSION_TOKEN_FILENAME = "session-token";
const TASKS_FILE = "tasks.json";
const WORKTREES_DIR = "worktrees";

/** Czego `agents` potrzebuje od `procs`; podłączane w fasadzie. */
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
}

/**
 * What `agents` needs from `workspace`: a repo root by its id (`not_found` without such a repo) and the projects folder
 * the supervisor runs in (`bad_request` while it is not set).
 */
interface AgentsRepos {
  repoPath(id: string): Promise<string>;
  projectsDir(): Promise<string>;
}

export interface AgentsDeps {
  procs: AgentsProcs;
  repos: AgentsRepos;
  /** Worktree i gałęzie zadań (ADR-31). */
  vcs: TasksVcs;
  /**
   * Katalog stanu daemona; sesje trzymają swoje pliki w `sessions/<sesja>/`, zadania listę w `tasks.json`, a swoje
   * worktree w `worktrees/<repo>/`.
   */
  home: string;
  /** Program Copilot CLI (nazwa z `PATH` albo pełna ścieżka) z argumentami przed argumentami sesji; w daemonie `["copilot"]`. */
  copilot: readonly string[];
  /** The daemon's version, which every session learns from its session instructions. */
  version: string;
  /** Środowisko procesów użytkownika (`PATH` z powłoki logowania na macOS). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Program hooka wtyczki sesji dla zdarzenia: daemon z podkomendą `copilot-hook` (bez `cwd`, ustala je moduł). */
  hookCommand: (event: CopilotHookEvent, hooksFile: string) => Omit<HookCommand, "cwd">;
  /**
   * Most stdio do serwera MCP daemona (§5.3) z plikiem tokenu sesji (ADR-39): każda sesja dostaje serwer `trackwall`
   * przez `--additional-mcp-config`, a serwer wie po tokenie, która sesja woła.
   */
  sessionMcpCommand: (tokenFile: string) => readonly string[];
  /** Otwiera katalog w VS Code (worktree zadania). */
  openEditor: (dir: string) => void;
  log: (msg: string) => void;
}

/** Na co czeka `wait_for_session`: sesja albo zadanie (także propozycja, która ma stać się zadaniem). */
export type WaitTarget = { session: string } | { task: string };

export class Agents {
  readonly #deps: AgentsDeps;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #tokens = new SessionTokens();
  readonly #tasks: AgentTasks;
  readonly #proposals = new TaskProposals();
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
      worktreesDir,
      openEditor: deps.openEditor,
      log: deps.log,
      sessions: {
        launch: (spec) => this.#launch(spec),
        of: (task) => this.#views().filter((s) => s.task === task),
        close: (id) => this.#close(id),
      },
    });
  }

  sessions(): SessionList {
    const tasks = this.#tasks.list();
    // Zatwierdzana propozycja, z której jest już zadanie, jest tylko zadaniem: UI i `list_sessions` widzą jeden obiekt.
    const proposals = this.#proposals.list().filter((p) => !tasks.some((t) => t.id === p.id));
    return { sessions: this.#views(), tasks, proposals, worktreesDir: this.#worktreesDir };
  }

  /** Jedna sesja z listy (`not_found`, gdy jej nie ma albo użytkownik ją zamknął). */
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
    const running = this.#views().find((s) => isSupervisor(s) && s.run.kind !== "exited");
    if (running) return running;
    this.#supervisorStart = this.#replaceSupervisor().finally(() => {
      this.#supervisorStart = undefined;
    });
    return this.#supervisorStart;
  }

  async #replaceSupervisor(): Promise<Session> {
    const ended = this.#views().filter(isSupervisor);
    const cwd = await this.#deps.repos.projectsDir();
    const started = await this.#launch({ repo: null, cwd, task: null, args: [], promptOnStart: false });
    // One of them may have been dismissed during the start; the start has still succeeded.
    for (const old of ended) if (this.#sessions.has(old.id)) this.#close(old.id);
    return started;
  }

  /** Sesja, której token sesji przyszedł z mostu stdio; `undefined` dla nieznanego tokenu. */
  callerSession(token: string): string | undefined {
    return this.#tokens.session(token);
  }

  /** Propozycja zadania od sesji `caller` (`null`: agent spoza Trackwall) w repo z folderu z projektami (ADR-39). */
  async propose(caller: string | null, proposal: { repo: string; title: string; prompt: string }): Promise<TaskProposal> {
    await this.#deps.repos.repoPath(proposal.repo);
    const supervisor = caller !== null && isSupervisor(this.session(caller));
    return this.#proposals.add({ ...proposal, proposedBy: { session: caller, supervisor } });
  }

  /**
   * Zadanie z propozycji, z poleceniem poprawionym przez użytkownika. Propozycja zostaje na liście, dopóki nie ma
   * zadania z jej identyfikatorem, ale drugie zatwierdzenie to `not_found`; znów czeka na decyzję, gdy zadanie nie
   * powstało. Zadanie, które zostało po nieudanym sprzątaniu, użytkownik kończy sam, więc wtedy propozycja znika.
   */
  async approveProposal(id: string, prompt: string): Promise<Task> {
    const { repo, title, proposedBy } = this.#proposals.take(id);
    try {
      return await this.#tasks.create(repo, prompt, { id, title, proposedBy });
    } finally {
      this.#proposals.release(id, this.#tasks.find(id) === undefined);
    }
  }

  rejectProposal(id: string, reason: string | undefined): void {
    this.#proposals.reject(id, reason ?? null);
  }

  /** Podsumowanie od sesji `caller` do jej własnego zadania (`report_result`). */
  reportSummary(caller: string | null, text: string): Task {
    const task = caller === null ? null : this.session(caller).task;
    if (task === null) throw new DomainError("bad_request", "only a session that runs a task in Trackwall can report a result");
    return this.#tasks.setSummary(task, text);
  }

  /** Czeka, aż sesja albo zadanie będzie wymagać kogoś, najwyżej `timeoutMs`; na własną sesję czekać nie można. */
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

  /** Zadanie po identyfikatorze (`not_found`, gdy go nie ma albo użytkownik je zakończył). */
  task(id: string): Task {
    return this.#tasks.task(id);
  }

  taskChanges(id: string): Promise<TaskChanges> {
    return this.#tasks.changes(id);
  }

  /** Other tasks of the same repo that change the same files (ADR-44). */
  taskSharedFiles(id: string): Promise<TaskSharedFiles[]> {
    return this.#tasks.sharedFiles(id);
  }

  /** Zmiany zadania bez diffu, dla agenta (narzędzie MCP `get_session`). */
  taskChangesSummary(id: string): Promise<TaskChangesSummary> {
    return this.#tasks.summary(id);
  }

  openTaskEditor(id: string): void {
    this.#tasks.openEditor(id);
  }

  removeTask(id: string, keepBranch: boolean, discardChanges: boolean): Promise<void> {
    return this.#tasks.remove(id, keepBranch, discardChanges);
  }

  /**
   * Copilot CLI w `cwd` (korzeń repo albo worktree zadania `task`) z argumentami przed argumentami sesji;
   * `promptOnStart`, gdy argumenty niosą pierwszą wiadomość (`--interactive`), więc sesja od startu pracuje.
   */
  async #launch({ repo, cwd, task, args, promptOnStart }: LaunchSpec): Promise<Session> {
    const env = { ...(await this.#deps.env()), TERM: "xterm-256color", COLORTERM: "truecolor" };
    const [name = "copilot", ...prefix] = this.#deps.copilot;
    const program = findCopilot(name, env);
    if (!program) throw new DomainError("agent_unavailable", `Copilot CLI (${name}) not found in PATH`);
    const id = randomUUID();
    const dir = this.#sessionDir(id);
    const token = this.#tokens.issue(id);
    let prepared: PreparedSession;
    try {
      prepared = this.#prepare({ id, repo, task, dir, token, promptOnStart });
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
    this.#startTicking();
    return this.#view(session);
  }

  async stop(id: string): Promise<Session> {
    const session = this.#get(id);
    await this.#deps.procs.stop(owner(id));
    return this.#view(session);
  }

  /** Zamyka zakończoną sesję: znika z listy, a jej pliki z katalogu stanu. Zadanie sesji zostaje. */
  dismiss(id: string): SessionList {
    this.#close(id);
    return this.sessions();
  }

  /** Okno terminala sesji: najpierw obraz ekranu, potem wyjście na bieżąco, a `onClosed`, gdy sesja zniknie. */
  attach(id: string, viewer: ScreenViewer, onSnapshot: (snapshot: string) => void, onClosed: () => void): SessionWindow {
    return this.#get(id).attach(viewer, onSnapshot, onClosed);
  }

  /** Start daemona: pliki sesji z poprzedniego działania (sesje nie przeżywają daemona). */
  sweepLeftovers(): void {
    try {
      rmSync(join(this.#deps.home, "sessions"), { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`cleaning up the session directory: ${String(err)}`);
    }
  }

  /** Wyjście daemona: procesy zatrzymuje `procs.stopAll`, tu kończy się tylko obserwowanie. */
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
    session.dispose();
    this.#removeDir(id);
  }

  /** Sesje od najnowszej. */
  #views(): Session[] {
    return [...this.#sessions.values()].flatMap((s) => this.#fresh(s) ?? []).reverse();
  }

  /**
   * The session directory with the session plugin, MCP config, session token, session instructions and an empty
   * `hooks.jsonl`, before Copilot CLI starts.
   */
  #prepare({ id, repo, task, dir, token, promptOnStart }: SessionFiles): PreparedSession {
    const pluginDir = join(dir, "plugin");
    const hooksFile = join(dir, "hooks.jsonl");
    const tokenFile = join(dir, SESSION_TOKEN_FILENAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(hooksFile, "");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const mcpConfig = copilotMcpServers(this.#deps.sessionMcpCommand(tokenFile));
    writeFileSync(join(dir, MCP_CONFIG_FILE), JSON.stringify(mcpConfig, null, 2));
    writeCopilotPlugin(pluginDir, (event) => ({ ...this.#deps.hookCommand(event, hooksFile), cwd: pluginDir }));
    const instructionsDir = writeSessionInstructions(dir, this.#deps.version, { repo, task });
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
      run: () => this.#deps.procs.state(owner(id)),
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

  #get(id: string): LiveSession {
    const session = this.#sessions.get(id);
    if (!session) throw new DomainError("not_found", `no session ${id}`);
    return session;
  }

  /** Stan sesji po przeczytaniu nowych rekordów hooków i końca procesu. */
  #fresh(session: LiveSession): Session | undefined {
    session.tick();
    return session.view();
  }

  #view(session: LiveSession): Session {
    const view = this.#fresh(session);
    if (!view) throw new Error(`session ${session.id} has no process group`);
    return view;
  }

  #sessionDir(id: string): string {
    return join(this.#deps.home, "sessions", id);
  }

  #removeDir(id: string): void {
    try {
      rmSync(this.#sessionDir(id), { recursive: true, force: true });
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

/** Katalog nowej sesji i to, co z niego wynika dla `LiveSession`. */
interface SessionFiles {
  id: string;
  repo: string | null;
  task: string | null;
  dir: string;
  token: string;
  promptOnStart: boolean;
}

/** A prepared session directory: the session and its instructions directory (`null` when it could not be written). */
interface PreparedSession {
  session: LiveSession;
  instructionsDir: string | null;
}

/** Klucz właściciela grupy w `procs`; tylko budowany, nigdy rozbierany z powrotem. */
function owner(id: string): string {
  return `agent:${id}`;
}

function domainError(repo: string | null, err: unknown): unknown {
  if (!(err instanceof SpawnFailure)) return err;
  const place = repo ?? "the projects folder";
  return new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "agent_unavailable", `${place}: ${err.message}`);
}
