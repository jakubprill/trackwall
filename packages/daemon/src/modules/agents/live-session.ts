import type { RunState, Session, TaskStateChange } from "@trackwall/protocol";
import { CopilotSessionState } from "./copilot-session-state.ts";
import { HookTail } from "./hook-tail.ts";
import { type ScreenViewer, TerminalScreen } from "./terminal-screen.ts";

/**
 * Jedna działająca (albo zakończona) sesja Copilot CLI w daemonie (§4.4): ekran dla okien terminala, stan z hooków
 * i OSC oraz terminal do pisania. Proces i jego grupę trzyma moduł `procs`; sesja tylko obserwuje jego stan.
 */

/** Ten sam próg co w prototypie (`copilot-record.ts`), żeby nagranie i daemon liczyły `Stale` tak samo. */
export const STALE_AFTER_MS = 60_000;

/** Terminal procesu sesji, z `procs` (`GroupTerminal`). */
export interface SessionTerminal {
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
  #terminal: SessionTerminal | undefined;
  #last: TaskStateChange | null = null;
  #finished = false;

  constructor(o: LiveSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.#run = o.run;
    this.#screen = new TerminalScreen(o.cols, o.rows);
    this.#hooks = new HookTail(o.hooksFile);
  }

  /** Terminal procesu; przychodzi po starcie grupy, a wyjście może przyjść już wcześniej. */
  connect(terminal: SessionTerminal): void {
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

  attach(viewer: ScreenViewer, onSnapshot: (snapshot: string) => void): () => void {
    return this.#screen.attach(viewer, onSnapshot);
  }

  /** Wołane cyklicznie: nowe rekordy hooków, próg `Stale` i koniec procesu; po końcu nic już nie zmienia stanu. */
  tick(): void {
    if (this.#finished) return;
    for (const record of this.#hooks.read()) this.#report(this.#state.hook(record));
    this.#report([this.#state.tick()]);
    const run = this.#run();
    if (run?.kind !== "exited") return;
    // Zatrzymanie przez użytkownika to zamierzony koniec, nie błąd sesji, choć proces kończy się sygnałem.
    this.#report([this.#state.exit(run.stoppedByUser ? 0 : (run.exitCode ?? 1))]);
    this.#finished = true;
    this.#hooks.close();
  }

  /** Najpierw `tick`: koniec procesu widać w `procs` wcześniej niż w cyklu sesji, a stan musi już go uwzględniać. */
  view(): Session | undefined {
    this.tick();
    const run = this.#run();
    if (!run) return undefined;
    return {
      id: this.id,
      repo: this.repo,
      startedAt: this.startedAt,
      run,
      state: this.#last,
      windowTitle: this.#state.windowTitle ?? null,
    };
  }

  dispose(): void {
    if (!this.#finished) this.#hooks.close();
    this.#finished = true;
    this.#screen.dispose();
  }

  #report(changes: readonly (TaskStateChange | undefined)[]): void {
    for (const change of changes) if (change) this.#last = change;
  }
}
