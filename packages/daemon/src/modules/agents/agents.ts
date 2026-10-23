import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState, Session, SessionList } from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../errors.ts";
import { findCopilot } from "./copilot-command.ts";
import type { CopilotHookEvent } from "./copilot-hook-record.ts";
import { type HookCommand, writeCopilotPlugin } from "./copilot-plugin.ts";
import { LiveSession, type SessionPty } from "./live-session.ts";
import type { ScreenViewer } from "./terminal-screen.ts";

/**
 * Moduł `agents` (§4.4, ADR-26): sesje Copilot CLI uruchamiane z UI w repo z folderu z projektami, kilka naraz.
 * Każda sesja to Copilot CLI w PTY należącym do daemona, w grupie procesów modułu `procs`, z wtyczką sesji, której
 * hooki zgłaszają stan (ADR-17). Komendę składa daemon; z zewnątrz przychodzi tylko identyfikator repo (§1.2).
 * Sesje żyją w pamięci daemona: wyjście daemona zatrzymuje je razem z innymi grupami procesów.
 */

/** Rozmiar PTY, zanim okno terminala zgłosi swój. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;
/** Jak często sesje czytają rekordy hooków i sprawdzają koniec procesu. */
const TICK_MS = 200;

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
  /** Katalog stanu daemona; sesje trzymają swoje pliki w `sessions/<sesja>/`. */
  home: string;
  /** Program Copilot CLI (nazwa z `PATH` albo pełna ścieżka) z argumentami przed argumentami sesji; w daemonie `["copilot"]`. */
  copilot: readonly string[];
  /** Środowisko procesów użytkownika (`PATH` z powłoki logowania na macOS). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Program hooka wtyczki sesji dla zdarzenia: daemon z podkomendą `copilot-hook` (bez `cwd`, ustala je moduł). */
  hookCommand: (event: CopilotHookEvent, hooksFile: string) => Omit<HookCommand, "cwd">;
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
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: AgentsDeps) {
    this.#deps = deps;
  }

  sessions(): SessionList {
    const sessions = [...this.#sessions.values()].flatMap((s) => this.#fresh(s) ?? []);
    return { sessions: sessions.reverse() };
  }

  async start(repo: string): Promise<Session> {
    const cwd = await this.#deps.repos.repoPath(repo);
    const env = { ...(await this.#deps.env()), TERM: "xterm-256color", COLORTERM: "truecolor" };
    const [name = "copilot", ...prefix] = this.#deps.copilot;
    const program = findCopilot(name, env);
    if (!program) throw new DomainError("agent_unavailable", `nie znaleziono Copilot CLI (${name}) w PATH`);
    const id = randomUUID();
    const dir = this.#sessionDir(id);
    const session = this.#prepare(id, repo, dir);
    try {
      const { terminal } = await this.#deps.procs.startTerminal({
        owner: owner(id),
        command: [program, ...prefix, "--plugin-dir", join(dir, "plugin")],
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

  /** Zamyka zakończoną sesję: znika z listy, a jej pliki z katalogu stanu. */
  dismiss(id: string): SessionList {
    const session = this.#get(id);
    if (this.#deps.procs.state(owner(id))?.kind !== "exited") {
      throw new DomainError("bad_request", "sesja jeszcze działa; zatrzymaj ją przed zamknięciem");
    }
    this.#sessions.delete(id);
    session.dispose();
    this.#removeDir(id);
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
      this.#deps.log(`sprzątanie katalogu sesji: ${String(err)}`);
    }
  }

  /** Wyjście daemona: procesy zatrzymuje `procs.stopAll`, tu kończy się tylko obserwowanie. */
  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Katalog sesji z wtyczką sesji i pustym `hooks.jsonl`, zanim Copilot CLI wystartuje. */
  #prepare(id: string, repo: string, dir: string): LiveSession {
    const pluginDir = join(dir, "plugin");
    const hooksFile = join(dir, "hooks.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(hooksFile, "");
    writeCopilotPlugin(pluginDir, (event) => ({ ...this.#deps.hookCommand(event, hooksFile), cwd: pluginDir }));
    return new LiveSession({ id, repo, cols: INITIAL_COLS, rows: INITIAL_ROWS, hooksFile, run: () => this.#deps.procs.state(owner(id)) });
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
        this.#deps.log(`sesja ${session.id}: ${String(err)}`);
      }
    }
    if (live === 0) this.close();
  }

  #get(id: string): LiveSession {
    const session = this.#sessions.get(id);
    if (!session) throw new DomainError("not_found", `nie ma sesji ${id}`);
    return session;
  }

  /** Stan sesji po przeczytaniu nowych rekordów hooków i końca procesu. */
  #fresh(session: LiveSession): Session | undefined {
    session.tick();
    return session.view();
  }

  #view(session: LiveSession): Session {
    const view = this.#fresh(session);
    if (!view) throw new Error(`sesja ${session.id} bez grupy procesów`);
    return view;
  }

  #sessionDir(id: string): string {
    return join(this.#deps.home, "sessions", id);
  }

  #removeDir(id: string): void {
    try {
      rmSync(this.#sessionDir(id), { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`usuwanie plików sesji ${id}: ${String(err)}`);
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
