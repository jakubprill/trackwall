import type { AgentDialog, DialogAnswer, RunState, Session, TaskState, TaskStateChange, TaskUpdate } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import type { CopilotHookEvent } from "./copilot-hook-record.ts";
import { answersDialog, ESCAPE, type SessionKey, sessionKey } from "./copilot-keys.ts";
import { CopilotSessionState, RETYPE_AFTER_MS } from "./copilot-session-state.ts";
import { HookTail } from "./hook-tail.ts";
import { SessionAttention } from "./session-attention.ts";
import { SessionDialogs, selectsOption } from "./session-dialogs.ts";
import { type ScreenViewer, TerminalScreen } from "./terminal-screen.ts";

/**
 * One running (or ended) Copilot CLI session in the daemon (§4.4): the screen for session terminals, the state from hooks,
 * OSC and session keys, and the terminal to write to. The `procs` module holds the process and its group; the session
 * only observes its state.
 */

/** The same threshold as in the prototype (`copilot-record.ts`), so that the recording and the daemon compute `Stale` the same way. */
export const STALE_AFTER_MS = 60_000;

/**
 * The pause between the text of a prompt the daemon types and its Enter (ADR-62, ADR-68): written together, the TUI reads them as
 * one pasted string, in which a carriage return is text and does not submit.
 */
const SUBMIT_DELAY_MS = 100;

/** The states in which the session waits for an answer to a dialog, and the kind of dialog that answers it (ADR-66). */
const DIALOG_IN_STATE: ReadonlyMap<TaskState, AgentDialog["kind"]> = new Map([
  ["Approval", "approval"],
  ["Input", "question"],
]);

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
  return data === ESCAPE || !data.startsWith(ESCAPE);
}

/**
 * Text the user put into the input box: typed, or pasted (xterm.js sends a bracketed paste, which starts with ESC), but
 * not Esc and not an answer in an approval or plan dialog, which leave nothing there.
 */
function writesText(data: string, state: TaskState | undefined): boolean {
  if (state === "Approval" || state === "Plan") return false;
  return !data.startsWith(ESCAPE) || data.startsWith(`${ESCAPE}[200~`);
}

type SessionUpdate = Extract<TaskUpdate, { kind: "turn_ended" | "error" | "exited" }>;

/**
 * What the session's agent did, for the proposer of the session's task (ADR-68): a turn it worked on ended (hook
 * `agentStop`; not a turn the user drove), an error, or the process ended. A task update without the task, session and time.
 */
export type SessionEvent = {
  [K in SessionUpdate["kind"]]: Omit<Extract<SessionUpdate, { kind: K }>, "task" | "session" | "at">;
}[SessionUpdate["kind"]];

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
  /** The Copilot CLI program the session runs, the full path from `findCopilot`. */
  program: string;
  /** The state of the session's process group in `procs`; `undefined` before the start. */
  run: () => RunState | undefined;
  /**
   * The daemon's prompt for what waits unread for this session (a review, messages, updates; ADR-62, ADR-68), read
   * when it is about to be typed; `undefined` when nothing waits any more.
   */
  prompt: () => string | undefined;
  /** The user put text into the session's input box (typed or pasted; not an answer to a dialog, not Esc). */
  onUserText: () => void;
  /** Called synchronously, from whichever call read the change (hooks are read on every input and state read). */
  onEvent: (event: SessionEvent) => void;
}

export class LiveSession {
  readonly id: string;
  readonly repo: string | null;
  readonly task: string | null;
  readonly startedAt = new Date().toISOString();
  readonly #run: () => RunState | undefined;
  readonly #promptText: () => string | undefined;
  readonly #onUserText: () => void;
  readonly #onEvent: (event: SessionEvent) => void;
  readonly #screen: TerminalScreen;
  readonly #state: CopilotSessionState;
  readonly #hooks: HookTail;
  readonly #decoder = new TextDecoder();
  #terminal: SessionPty | undefined;
  #last: TaskStateChange | null = null;
  readonly #attention = new SessionAttention();
  #finished = false;
  readonly #closers = new Set<() => void>();
  /** The daemon's prompt was asked for (`askToRead`) and goes in once the session waits in its input box. */
  #promptAsked = false;
  /** The daemon's prompt typed and not yet taken: it counts until the session leaves `Input`. */
  #promptTyped: { text: string; at: number } | undefined;
  /** The user typed or pasted since their last message was submitted, so the input box may hold their unsent text. */
  #userDraft = false;
  /** The user put text into the input box or pressed Esc since the last end of a turn: the next end is of their turn. */
  #userDrove = false;
  #submitTimer: NodeJS.Timeout | undefined;
  readonly #dialogs: SessionDialogs;
  /**
   * Approvals Copilot CLI drew before their hooks reached the daemon that the user already answered (ADR-71): when such
   * a hook comes, the answer it already got moves the session on, as the key would have in `Approval`.
   */
  #earlyAnswers = 0;

  constructor(o: LiveSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.task = o.task;
    this.#run = o.run;
    this.#promptText = o.prompt;
    this.#onUserText = o.onUserText;
    this.#onEvent = o.onEvent;
    this.#state = new CopilotSessionState({
      now: Date.now,
      staleAfterMs: STALE_AFTER_MS,
      promptOnStart: o.promptOnStart,
      program: o.program,
    });
    this.#screen = new TerminalScreen(o.cols, o.rows);
    this.#dialogs = new SessionDialogs(this.#screen);
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
    // After the hooks already written, so that an end of a turn read now does not let a prompt join the user's text.
    // The answer to the agent's question (on the screen in `Input`, ADR-66) leaves nothing in the input box either.
    const key = sessionKey(data);
    const state = this.#last?.state;
    const midTurn = state === "Working" || state === "Stale";
    // A digit or Enter mid-turn into an approval Copilot CLI drew before its hook (ADR-71), answered already or not,
    // leaves nothing in the input box. Only mid-turn, so a message the user starts with a digit is still their text.
    const intoApproval = midTurn && key !== undefined && answersDialog(key) && this.#dialogs.approvalDrawn();
    if (writesText(data, state) && this.#dialog() === null && !intoApproval) {
      this.#userDraft = true;
      this.#userDrove = true;
      this.#onUserText();
    }
    if (data === ESCAPE) this.#userDrove = true;
    if (key && this.#keyChangesState(key, data)) this.#report(this.#state.key(key));
    // After the key's own state change, so that the `Input` an Esc causes counts as seen.
    if (typedByUser(data)) this.#attention.typed();
  }

  /**
   * Notes a key that selects an option of the approval on the screen, and tells whether the key goes to the state
   * detectors: a digit the approval does not offer answers nothing (it does nothing, or moves the selection to a "No"
   * option), so the session still waits.
   */
  #keyChangesState(key: SessionKey, data: string): boolean {
    const state = this.#last?.state;
    const midTurn = state === "Working" || state === "Stale";
    const approval = state === "Approval" || midTurn ? this.#dialogOnScreen("approval") : null;
    if (approval === null) return true;
    const answers = selectsOption(approval, key, data);
    if (answers) {
      if (midTurn) this.#earlyAnswers++;
      this.#dialogs.answered();
    }
    return answers || state !== "Approval" || key !== "choice";
  }

  /**
   * Asks the session to read what waits for it (ADR-62, ADR-68): the daemon types its prompt (`prompt`, read at that
   * moment) at once while the session waits in its input box (`CopilotSessionState.inPromptBox`, ADR-69), otherwise as soon as it does again.
   * Never in the middle of a turn, in an approval or a question dialog, after the user's Esc or into text the user is
   * typing. One prompt at a time: while a typed one has not been taken, a request it already covers (the same text)
   * changes nothing, since the prompt asks to read everything unread; one it does not cover goes in after the next turn,
   * and one not taken within `RETYPE_AFTER_MS` is typed again.
   */
  askToRead(): "typed" | "queued" {
    this.#readHooks();
    const typed = this.#promptTyped;
    if (typed && Date.now() - typed.at > RETYPE_AFTER_MS) this.#promptTyped = undefined;
    else if (typed && typed.text === this.#promptText()) return "typed";
    this.#promptAsked = true;
    this.#typePrompt();
    return this.#promptAsked ? "queued" : "typed";
  }

  /**
   * Answers the approval on the screen (ADR-66) with an option's digit or Esc, as if the user pressed the key in a
   * session terminal, but only while the emulator's screen still shows the dialog `id` names, in the same wait: an
   * answer does not go into a request asked after the one the user saw, even an identical one. Output the emulator has
   * not processed yet is not seen; a key typed into a dialog that just appeared reaches it as a key from the terminal would.
   */
  answerDialog(id: string, answer: DialogAnswer): void {
    const dialog = this.#dialog();
    if (dialog?.id !== id)
      throw new DomainError("dialog_changed", "the dialog is no longer on the session's screen; it was answered or it changed");
    if (dialog.kind === "question") throw new DomainError("bad_request", "a question from the agent is answered in the session terminal");
    if (answer !== "stop" && !dialog.options.some((o) => o.key === answer))
      throw new DomainError("bad_request", `the dialog has no option ${answer} that can be answered outside the terminal`);
    this.input(answer === "stop" ? ESCAPE : answer);
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
    if (!this.#finished) this.#dialogs.forgetAnswerOffScreen();
    // A prompt asked for goes into a box that just appeared before the box can say the session waits for you.
    this.#typePrompt();
    this.#readPromptBox();
    const run = this.#run();
    if (run?.kind !== "exited") return true;
    // A stop by the user is an intended end, not a session error, even though the process ends with a signal.
    // Finished first, so the `Error` a failed exit gives is reported as the exit, not also as an error.
    this.#finished = true;
    // The last hooks may have been written between the read above and the end the process state shows.
    this.#readHooks();
    this.#report(this.#state.exit(run.stoppedByUser ? 0 : (run.exitCode ?? 1)));
    this.#hooks.close();
    this.#onEvent({ kind: "exited", exitCode: run.exitCode, stoppedByUser: run.stoppedByUser });
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
      dialog: run.kind === "running" ? this.#dialog() : null,
    };
  }

  /**
   * The agent dialog on the screen that matches the state: an approval in `Approval`, a question in `Input`. The state
   * decides, so a dialog Copilot CLI has not cleared from the screen yet after a key is gone at once.
   */
  #dialog(): AgentDialog | null {
    const kind = this.#last ? DIALOG_IN_STATE.get(this.#last.state) : undefined;
    return kind === undefined ? null : this.#dialogOnScreen(kind);
  }

  /** The agent dialog of `kind` the screen shows now, whatever the state (`SessionDialogs.onScreen`). */
  #dialogOnScreen(kind: AgentDialog["kind"]): AgentDialog | null {
    return this.#finished ? null : this.#dialogs.onScreen(kind);
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
    for (const record of this.#hooks.read()) {
      if (record.event === "userPromptSubmitted") this.#userDraft = false;
      this.#report(this.#state.hook(record, () => this.#dialogOnScreen("approval") !== null));
      this.#applyEarlyAnswer(record.event);
      // The end of a turn from its hook, not from the state: a question dialog and an Esc give `Input` mid-turn too.
      if (record.event === "agentStop") {
        if (!this.#userDrove) this.#onEvent({ kind: "turn_ended" });
        this.#userDrove = false;
      }
    }
  }

  /**
   * The approval's hook after the user already answered it (ADR-71) would leave the session in `Approval` until the
   * command ends, so the answer counts now, one per hook. Any other hook of the turn means the answers went to no
   * approval of record.
   */
  #applyEarlyAnswer(event: CopilotHookEvent): void {
    if (this.#earlyAnswers === 0) return;
    if (this.#last?.state === "Approval") {
      this.#earlyAnswers--;
      this.#report(this.#state.key("choice"));
    } else if (event !== "notification") this.#earlyAnswers = 0;
  }

  /** Until the session has a state, its screen may show the input box of a new session (ADR-69). */
  #readPromptBox(): void {
    if (this.#last === null) this.#report(this.#state.screen(() => this.#screen.lines()));
  }

  #report(changes: readonly (TaskStateChange | undefined)[]): void {
    for (const change of changes) {
      if (!change) continue;
      this.#attention.changed(this.#last?.state, change.state);
      if (change.state !== this.#last?.state && DIALOG_IN_STATE.has(change.state)) this.#dialogs.waitStarted();
      const wasError = this.#last?.state === "Error";
      this.#last = change;
      if (change.state === "Error" && !wasError && !this.#finished) this.#onEvent({ kind: "error" });
      // Copilot CLI took the typed prompt: the turn it started is the session's, and the next prompt is a new one.
      if (change.state !== "Input") this.#promptTyped = undefined;
    }
  }

  /** The asked-for prompt goes into the PTY in an empty input box; Enter follows after `SUBMIT_DELAY_MS`. */
  #typePrompt(): void {
    const terminal = this.#terminal;
    // Decided once after a batch of hook records, so a turn that ended and started again in one read gets nothing.
    if (!this.#promptAsked || this.#promptTyped || this.#finished || !terminal || this.#userDraft) return;
    if (this.#last !== null && this.#last.state !== "Input") return;
    if (!this.#state.inPromptBox(() => this.#screen.lines())) return;
    // The hooks say the input box, but the screen still shows the agent's question (its hook lost or late, ADR-66): the
    // prompt with Enter would answer it.
    if (this.#dialog() !== null) return;
    this.#promptAsked = false;
    // Everything may have been read meanwhile (the agent called the tool on its own): then there is nothing to ask.
    const text = this.#promptText();
    if (text === undefined) return;
    this.#promptTyped = { text, at: Date.now() };
    this.#state.promptTyped();
    // The daemon starts this turn: an Esc earlier (an interrupt gives no `agentStop`) does not make it the user's.
    this.#userDrove = false;
    terminal.write(text);
    this.#submitTimer = setTimeout(() => {
      if (!this.#finished) terminal.write("\r");
    }, SUBMIT_DELAY_MS);
    this.#submitTimer.unref();
  }
}
