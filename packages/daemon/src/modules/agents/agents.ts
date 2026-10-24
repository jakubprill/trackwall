import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copilotMcpServers,
  type RunState,
  type Session,
  type SessionList,
  type Task,
  type TaskChanges,
  type TaskChangesSummary,
} from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { findCopilot } from "./copilot-command.ts";
import type { CopilotHookEvent } from "./copilot-hook-record.ts";
import { type HookCommand, writeCopilotPlugin } from "./copilot-plugin.ts";
import { LiveSession, type SessionPty } from "./live-session.ts";
import { TaskFile } from "./task-file.ts";
import { AgentTasks, type TasksVcs } from "./tasks.ts";
import type { ScreenViewer } from "./terminal-screen.ts";

/**
 * Moduł `agents` (§4.4, ADR-26): sesje Copilot CLI uruchamiane z UI w repo z folderu z projektami, kilka naraz.
 * Każda sesja to Copilot CLI w PTY należącym do daemona, w grupie procesów modułu `procs`, z wtyczką sesji, której
 * hooki zgłaszają stan (ADR-17). Komendę składa daemon; z zewnątrz przychodzi tylko identyfikator repo (§1.2).
 * Sesje żyją w pamięci daemona: wyjście daemona zatrzymuje je razem z innymi grupami procesów. Sesja może należeć
 * do zadania (ADR-31, `tasks.ts`): działa wtedy w worktree zadania, a zadanie przeżywa daemona.
 */

/** Rozmiar PTY, zanim okno terminala zgłosi swój. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;
/** Jak często sesje czytają rekordy hooków i sprawdzają koniec procesu. */
const TICK_MS = 200;
/** Konfiguracja MCP sesji w katalogu sesji; plik zamiast JSON w argumencie, żeby cudzysłowy JSON-u nie zależały od cytowania argumentów na Windowsie. */
const MCP_CONFIG_FILE = "mcp-config.json";
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

/** Czego `agents` potrzebuje od `workspace`: korzeń repo po identyfikatorze (`not_found`, gdy repo nie ma). */
interface AgentsRepos {
  repoPath(id: string): Promise<string>;
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
  /** Środowisko procesów użytkownika (`PATH` z powłoki logowania na macOS). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Program hooka wtyczki sesji dla zdarzenia: daemon z podkomendą `copilot-hook` (bez `cwd`, ustala je moduł). */
  hookCommand: (event: CopilotHookEvent, hooksFile: string) => Omit<HookCommand, "cwd">;
  /** Most stdio do serwera MCP daemona (§5.3): każda sesja dostaje serwer `trackwall` przez `--additional-mcp-config`. */
  mcpStdioCommand: readonly string[];
  /** Otwiera katalog w VS Code (worktree zadania). */
  openEditor: (dir: string) => void;
  log: (msg: string) => void;
}

/** Widz terminala sesji (okno w UI): wyjście, obraz ekranu na start i wejście z klawiatury. */
export interface SessionAttachment {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

export class Agents {
  readonly #deps: AgentsDeps;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #tasks: AgentTasks;
  readonly #worktreesDir: string;
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
        launch: (spec) => this.#launch(spec.repo, spec.cwd, spec.task, spec.args),
        of: (task) => this.#views().filter((s) => s.task === task),
        close: (id) => this.#close(id),
      },
    });
  }

  sessions(): SessionList {
    return { sessions: this.#views(), tasks: this.#tasks.list(), worktreesDir: this.#worktreesDir };
  }

  /** Jedna sesja z listy (`not_found`, gdy jej nie ma albo użytkownik ją zamknął). */
  session(id: string): Session {
    return this.#view(this.#get(id));
  }

  async start(repo: string): Promise<Session> {
    return this.#launch(repo, await this.#deps.repos.repoPath(repo), null, []);
  }

  createTask(repo: string, prompt: string): Promise<Task> {
    return this.#tasks.create(repo, prompt);
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

  /** Copilot CLI w `cwd` (korzeń repo albo worktree zadania `task`) z argumentami przed argumentami sesji. */
  async #launch(repo: string, cwd: string, task: string | null, args: readonly string[]): Promise<Session> {
    const env = { ...(await this.#deps.env()), TERM: "xterm-256color", COLORTERM: "truecolor" };
    const [name = "copilot", ...prefix] = this.#deps.copilot;
    const program = findCopilot(name, env);
    if (!program) throw new DomainError("agent_unavailable", `Copilot CLI (${name}) not found in PATH`);
    const id = randomUUID();
    const dir = this.#sessionDir(id);
    const session = this.#prepare(id, repo, task, dir);
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
        env,
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        onData: (bytes) => session.output(bytes),
      });
      session.connect(terminal);
    } catch (err) {
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
  attach(id: string, viewer: ScreenViewer, onSnapshot: (snapshot: string) => void, onClosed: () => void): SessionAttachment {
    const session = this.#get(id);
    const detach = session.attach(viewer, onSnapshot, onClosed);
    return { input: (data) => session.input(data), resize: (cols, rows) => session.resize(cols, rows), detach };
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
    session.dispose();
    this.#removeDir(id);
  }

  /** Sesje od najnowszej. */
  #views(): Session[] {
    return [...this.#sessions.values()].flatMap((s) => this.#fresh(s) ?? []).reverse();
  }

  /** Katalog sesji z wtyczką sesji, konfiguracją MCP i pustym `hooks.jsonl`, zanim Copilot CLI wystartuje. */
  #prepare(id: string, repo: string, task: string | null, dir: string): LiveSession {
    const pluginDir = join(dir, "plugin");
    const hooksFile = join(dir, "hooks.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(hooksFile, "");
    writeFileSync(join(dir, MCP_CONFIG_FILE), JSON.stringify(copilotMcpServers(this.#deps.mcpStdioCommand), null, 2));
    writeCopilotPlugin(pluginDir, (event) => ({ ...this.#deps.hookCommand(event, hooksFile), cwd: pluginDir }));
    return new LiveSession({
      id,
      repo,
      task,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      hooksFile,
      run: () => this.#deps.procs.state(owner(id)),
    });
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

/** Klucz właściciela grupy w `procs`; tylko budowany, nigdy rozbierany z powrotem. */
function owner(id: string): string {
  return `agent:${id}`;
}

function domainError(repo: string, err: unknown): unknown {
  if (!(err instanceof SpawnFailure)) return err;
  return new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "agent_unavailable", `${repo}: ${err.message}`);
}
