import type { RunState, Session, TaskState, TaskStateChange } from "@trackwall/protocol";
import { CopilotSessionState } from "./copilot-session-state.ts";
import { HookTail } from "./hook-tail.ts";
import { type ScreenViewer, TerminalScreen } from "./terminal-screen.ts";

/**
 * Jedna działająca (albo zakończona) sesja Copilot CLI w daemonie (§4.4): ekran dla okien terminala, stan z hooków
 * i OSC oraz terminal do pisania. Proces i jego grupę trzyma moduł `procs`; sesja tylko obserwuje jego stan.
 */

/** Ten sam próg co w prototypie (`copilot-record.ts`), żeby nagranie i daemon liczyły `Stale` tak samo. */
export const STALE_AFTER_MS = 60_000;

/** Stany, w których działająca sesja czeka na Ciebie (`Session.needsAttention`). */
const WAITING_STATES: ReadonlySet<TaskState> = new Set(["Input", "Approval", "Plan"]);

/** PTY procesu sesji: terminal lidera grupy z `procs` (`GroupTerminal`). */
export interface SessionPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface LiveSessionOptions {
  id: string;
  repo: string;
  cols: number;
  rows: number;
  /** `hooks.jsonl` sesji, do którego dopisują procesy hooków wtyczki sesji. */
  hooksFile: string;
  /** Stan grupy procesów sesji w `procs`; `undefined` przed startem. */
  run: () => RunState | undefined;
}

export class LiveSession {
  readonly id: string;
  readonly repo: string;
  readonly startedAt = new Date().toISOString();
  readonly #run: () => RunState | undefined;
  readonly #screen: TerminalScreen;
  readonly #state = new CopilotSessionState({ now: Date.now, staleAfterMs: STALE_AFTER_MS });
  readonly #hooks: HookTail;
  readonly #decoder = new TextDecoder();
  #terminal: SessionPty | undefined;
  #last: TaskStateChange | null = null;
  #finished = false;
  readonly #closers = new Set<() => void>();

  constructor(o: LiveSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.#run = o.run;
    this.#screen = new TerminalScreen(o.cols, o.rows);
    this.#hooks = new HookTail(o.hooksFile);
  }

  /** Terminal procesu; przychodzi po starcie grupy, a wyjście może przyjść już wcześniej. */
  connect(terminal: SessionPty): void {
    this.#terminal = terminal;
  }

  /** Wyjście PTY: na ekran, do okien terminala i do detektorów stanu (OSC). */
  output(bytes: Uint8Array): void {
    this.#screen.write(bytes);
    this.#report(this.#state.output(this.#decoder.decode(bytes, { stream: true })));
  }

  input(data: string): void {
    if (!this.#finished) this.#terminal?.write(data);
  }

  /** Rozmiar ustala ostatnie okno, które go zgłosiło; TUI dostaje go razem z PTY. */
  resize(cols: number, rows: number): void {
    if (this.#finished || (cols === this.#screen.cols && rows === this.#screen.rows)) return;
    this.#screen.resize(cols, rows);
    this.#terminal?.resize(cols, rows);
  }

  /** `onClosed` dostaje widz, którego sesja znika (`dismiss`), żeby jego okno nie czekało na wyjście, które nie przyjdzie. */
  attach(viewer: ScreenViewer, onSnapshot: (snapshot: string) => void, onClosed: () => void): () => void {
    const detach = this.#screen.attach(viewer, onSnapshot);
    this.#closers.add(onClosed);
    return () => {
      this.#closers.delete(onClosed);
      detach();
    };
  }

  /**
   * Nowe rekordy hooków, próg `Stale` i koniec procesu; po końcu nic już nie zmienia stanu. Wołane cyklicznie
   * i przed każdym odczytem stanu, bo koniec procesu widać w `procs` wcześniej niż w cyklu. Zwraca, czy sesja żyje.
   */
  tick(): boolean {
    if (this.#finished) return false;
    for (const record of this.#hooks.read()) this.#report(this.#state.hook(record));
    this.#report([this.#state.tick()]);
    const run = this.#run();
    if (run?.kind !== "exited") return true;
    // Zatrzymanie przez użytkownika to zamierzony koniec, nie błąd sesji, choć proces kończy się sygnałem.
    this.#report(this.#state.exit(run.stoppedByUser ? 0 : (run.exitCode ?? 1)));
    this.#finished = true;
    this.#hooks.close();
    return false;
  }

  view(): Session | undefined {
    const run = this.#run();
    if (!run) return undefined;
    return {
      id: this.id,
      repo: this.repo,
      startedAt: this.startedAt,
      run,
      state: this.#last,
      windowTitle: this.#state.windowTitle ?? null,
      needsAttention: run.kind === "running" && this.#last !== null && WAITING_STATES.has(this.#last.state),
    };
  }

  dispose(): void {
    if (!this.#finished) this.#hooks.close();
    this.#finished = true;
    for (const close of this.#closers) close();
    this.#closers.clear();
    this.#screen.dispose();
  }

  #report(changes: readonly (TaskStateChange | undefined)[]): void {
    for (const change of changes) if (change) this.#last = change;
  }
}
