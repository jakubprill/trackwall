import type { RunState, Session, TaskStateChange } from "@trackwall/protocol";
import { atPromptBox } from "./copilot-hooks.ts";
import { sessionKey } from "./copilot-keys.ts";
import { CopilotSessionState } from "./copilot-session-state.ts";
import { HookTail } from "./hook-tail.ts";
import { SessionAttention } from "./session-attention.ts";
import { type ScreenViewer, TerminalScreen } from "./terminal-screen.ts";

/**
 * One running (or ended) Copilot CLI session in the daemon (§4.4): the screen for session terminals, the state from hooks,
 * OSC and session keys, and the terminal to write to. The `procs` module holds the process and its group; the session
 * only observes its state.
 */

/** The same threshold as in the prototype (`copilot-record.ts`), so that the recording and the daemon compute `Stale` the same way. */
export const STALE_AFTER_MS = 60_000;

/**
 * The pause between the text of a prompt the daemon types and its Enter (ADR-62): written together, the TUI reads them as
 * one pasted string, in which a carriage return is text and does not submit.
 */
const SUBMIT_DELAY_MS = 100;

/** The PTY of the session process: the terminal of the group leader from `procs` (`GroupTerminal`). */
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
  /** `null` for the supervisor in the projects folder (ADR-58). */
  repo: string | null;
  /** The task in whose worktree the session runs; `null` in the repo root. */
  task: string | null;
  cols: number;
  rows: number;
  /** The session's `hooks.jsonl`, which the session plugin's hook processes append to. */
  hooksFile: string;
  /** Copilot CLI got the prompt as its first message (`--interactive`), so it works right after the start. */
  promptOnStart: boolean;
  /** The state of the session's process group in `procs`; `undefined` before the start. */
  run: () => RunState | undefined;
}

export class LiveSession {
  readonly id: string;
  readonly repo: string | null;
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
  /**
   * The daemon's prompt (`typePrompt`): queued until the session waits in its input box, then typed until the session
   * leaves `Input`, that is until Copilot CLI has taken it.
   */
  #prompt: { text: string; typed: boolean } | undefined;
  #submitTimer: NodeJS.Timeout | undefined;

  constructor(o: LiveSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.task = o.task;
    this.#run = o.run;
    this.#state = new CopilotSessionState({ now: Date.now, staleAfterMs: STALE_AFTER_MS, promptOnStart: o.promptOnStart });
    this.#screen = new TerminalScreen(o.cols, o.rows);
    this.#hooks = new HookTail(o.hooksFile);
  }

  /** The process terminal; it arrives after the group starts, and output can arrive earlier. */
  connect(terminal: SessionPty): void {
    this.#terminal = terminal;
  }

  /** PTY output: to the screen, to the session terminals and to the state detectors (OSC). */
  output(bytes: Uint8Array): void {
    this.#screen.write(bytes);
    this.#report(this.#state.output(this.#decoder.decode(bytes, { stream: true })));
  }

  /** Input from a session terminal: to the PTY, and an answer or interrupt key also to the state detectors. */
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

  /**
   * A prompt the daemon types on the user's behalf (ADR-62): at once while the session waits in its input box after a
   * hook (`atPromptBox`), otherwise as soon as it does again. Never in the middle of a turn, in an approval or a question
   * dialog, or right after the user's Esc, where the text would land in an answer. One prompt at a time: while one is
   * queued or typed and not yet taken, another changes nothing, since the prompt asks to read everything unread.
   */
  typePrompt(text: string): "typed" | "queued" {
    this.#readHooks();
    this.#prompt ??= { text, typed: false };
    this.#typePrompt();
    return this.#prompt?.typed ? "typed" : "queued";
  }

  /** The size is set by the last terminal that reported it; the TUI gets it together with the PTY. */
  resize(cols: number, rows: number): void {
    if (this.#finished || (cols === this.#screen.cols && rows === this.#screen.rows)) return;
    this.#screen.resize(cols, rows);
    this.#terminal?.resize(cols, rows);
  }

  /** `onClosed` goes to a viewer whose session disappears (`dismiss`), so that its terminal does not wait for output that will not come. */
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
   * New hook records, the `Stale` threshold and the end of the process; after the end nothing changes the state. Called
   * periodically and before every read of the state, because `procs` sees the end of the process sooner than the cycle.
   * Returns whether the session is alive.
   */
  tick(): boolean {
    if (this.#finished) return false;
    this.#readHooks();
    this.#report([this.#state.tick()]);
    const run = this.#run();
    if (run?.kind !== "exited") return true;
    // A stop by the user is an intended end, not a session error, even though the process ends with a signal.
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
    clearTimeout(this.#submitTimer);
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
    this.#typePrompt();
  }

  /** The queued prompt goes into the PTY in the input box; Enter follows after `SUBMIT_DELAY_MS`. */
  #typePrompt(): void {
    const terminal = this.#terminal;
    const prompt = this.#prompt;
    if (!prompt || this.#finished || !terminal) return;
    if (prompt.typed) {
      // Copilot CLI took the prompt: the turn it started is the session's, and the next prompt is a new one.
      if (this.#last?.state !== "Input") this.#prompt = undefined;
      return;
    }
    if (!this.#last || !atPromptBox(this.#last)) return;
    prompt.typed = true;
    terminal.write(prompt.text);
    this.#submitTimer = setTimeout(() => {
      if (!this.#finished) terminal.write("\r");
    }, SUBMIT_DELAY_MS);
    this.#submitTimer.unref();
  }
}
