import type { RunState, Session, TaskStateChange } from "@trackwall/protocol";
import { sessionKey } from "./copilot-keys.ts";
import { CopilotSessionState } from "./copilot-session-state.ts";
import { HookTail } from "./hook-tail.ts";
import { SessionAttention } from "./session-attention.ts";
import { type ScreenViewer, TerminalScreen } from "./terminal-screen.ts";

/**
 * Jedna działająca (albo zakończona) sesja Copilot CLI w daemonie (§4.4): ekran dla okien terminala, stan z hooków,
 * OSC i klawiszy sesji oraz terminal do pisania. Proces i jego grupę trzyma moduł `procs`; sesja tylko obserwuje jego stan.
 */

/** Ten sam próg co w prototypie (`copilot-record.ts`), żeby nagranie i daemon liczyły `Stale` tak samo. */
export const STALE_AFTER_MS = 60_000;

/** PTY procesu sesji: terminal lidera grupy z `procs` (`GroupTerminal`). */
export interface SessionPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

/** One session terminal (a viewer in the UI): keyboard input, size, focus and leaving. */
export interface SessionWindow {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  /** The window came in front of the user (focused and visible) or left (ADR-47). */
  focus(focused: boolean): void;
  detach(): void;
}

/**
 * Input the user typed, not an answer xterm.js sends by itself to a terminal query (colours, cursor position), which
 * starts with ESC and also comes from a window in the background. Esc alone is a key; arrows do not count.
 */
function typedByUser(data: string): boolean {
  return data === "\u001b" || !data.startsWith("\u001b");
}

export interface LiveSessionOptions {
  id: string;
  repo: string;
  /** Zadanie, w którego worktree działa sesja; `null` w korzeniu repo. */
  task: string | null;
  cols: number;
  rows: number;
  /** `hooks.jsonl` sesji, do którego dopisują procesy hooków wtyczki sesji. */
  hooksFile: string;
  /** Copilot CLI dostał polecenie jako pierwszą wiadomość (`--interactive`), więc po starcie od razu pracuje. */
  promptOnStart: boolean;
  /** Stan grupy procesów sesji w `procs`; `undefined` przed startem. */
  run: () => RunState | undefined;
}

export class LiveSession {
  readonly id: string;
  readonly repo: string;
  readonly task: string | null;
  readonly startedAt = new Date().toISOString();
  readonly #run: () => RunState | undefined;
  readonly #screen: TerminalScreen;
  readonly #state: CopilotSessionState;
  readonly #hooks: HookTail;
  readonly #decoder = new TextDecoder();
  #terminal: SessionPty | undefined;
  #last: TaskStateChange | null = null;
  readonly #attention = new SessionAttention();
  #finished = false;
  readonly #closers = new Set<() => void>();

  constructor(o: LiveSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.task = o.task;
    this.#run = o.run;
    this.#state = new CopilotSessionState({ now: Date.now, staleAfterMs: STALE_AFTER_MS, promptOnStart: o.promptOnStart });
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

  /** Wejście z okna terminala: do PTY, a klawisz odpowiedzi albo przerwania także do detektorów stanu. */
  input(data: string): void {
    if (this.#finished || !this.#terminal) return;
    this.#terminal.write(data);
    // Input counts from the state after the hooks already in `hooks.jsonl`, not after the last read cycle: a key
    // answers the prompt that is already there, and typing marks seen the end of a turn that has already been written.
    this.#readHooks();
    const key = sessionKey(data);
    if (key) this.#report(this.#state.key(key));
    // After the key's own state change, so that the `Input` an Esc causes counts as seen.
    if (typedByUser(data)) this.#attention.typed();
  }

  /** Rozmiar ustala ostatnie okno, które go zgłosiło; TUI dostaje go razem z PTY. */
  resize(cols: number, rows: number): void {
    if (this.#finished || (cols === this.#screen.cols && rows === this.#screen.rows)) return;
    this.#screen.resize(cols, rows);
    this.#terminal?.resize(cols, rows);
  }

  /** `onClosed` dostaje widz, którego sesja znika (`dismiss`), żeby jego okno nie czekało na wyjście, które nie przyjdzie. */
  attach(viewer: ScreenViewer, onSnapshot: (snapshot: string) => void, onClosed: () => void): SessionWindow {
    const detach = this.#screen.attach(viewer, onSnapshot);
    const attention = this.#attention.window();
    this.#closers.add(onClosed);
    return {
      input: (data) => this.input(data),
      resize: (cols, rows) => this.resize(cols, rows),
      focus: (focused) => attention.focus(focused),
      detach: () => {
        attention.close();
        this.#closers.delete(onClosed);
        detach();
      },
    };
  }

  /**
   * Nowe rekordy hooków, próg `Stale` i koniec procesu; po końcu nic już nie zmienia stanu. Wołane cyklicznie
   * i przed każdym odczytem stanu, bo koniec procesu widać w `procs` wcześniej niż w cyklu. Zwraca, czy sesja żyje.
   */
  tick(): boolean {
    if (this.#finished) return false;
    this.#readHooks();
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
      needsAttention: run.kind === "running" && this.#attention.waiting(this.#last?.state),
      task: this.task,
    };
  }

  dispose(): void {
    if (!this.#finished) this.#hooks.close();
    this.#finished = true;
    for (const close of this.#closers) close();
    this.#closers.clear();
    this.#screen.dispose();
  }

  #readHooks(): void {
    for (const record of this.#hooks.read()) this.#report(this.#state.hook(record));
  }

  #report(changes: readonly (TaskStateChange | undefined)[]): void {
    for (const change of changes) {
      if (!change) continue;
      this.#attention.changed(this.#last?.state, change.state);
      this.#last = change;
    }
  }
}
