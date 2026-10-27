import { createHash } from "node:crypto";
import type { AgentDialog, DialogAnswer, RunState, Session, TaskState, TaskStateChange, TaskUpdate } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { readAgentDialog, type ScreenDialog } from "./copilot-dialog.ts";
import { type CopilotHookOutput, hookOutputFor } from "./copilot-hook-output.ts";
import type { CopilotHookEvent, CopilotHookRecord } from "./copilot-hook-record.ts";
import { approvalRequest } from "./copilot-hooks.ts";
import { answersDialog, ESCAPE, type SessionKey, sessionKey } from "./copilot-keys.ts";
import { promptBoxText } from "./copilot-prompt-box.ts";
import { CopilotSessionState, RETYPE_AFTER_MS } from "./copilot-session-state.ts";
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
 * The pause between the text of a prompt the daemon types and its Enter (ADR-62, ADR-68): written together, the TUI reads them as
 * one pasted string, in which a carriage return is text and does not submit.
 */
const SUBMIT_DELAY_MS = 100;

/**
 * How many times the daemon tries again with a prompt it typed and the session did not take within `RETYPE_AFTER_MS`
 * (ADR-68): Enter again on text still in the input box (the TUI read the text and its Enter as one paste), or the
 * prompt typed again into a box it was lost from. After that it gives up until it is asked to read again.
 */
const DELIVERY_RETRIES = 2;

/**
 * How long the input box must stay empty after the user's last text before their draft counts as gone (ADR-68): text
 * they cleared with Ctrl+C or a slash command, or text Copilot CLI took into a running turn, sends no
 * `userPromptSubmitted`. Long enough for a key the user just pressed to reach the screen.
 */
const USER_DRAFT_SETTLE_MS = 2000;

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

/** A digest of the dialog's text and of the wait it answers, so the same request asked again gets another id. */
function dialogId(waits: number, dialog: ScreenDialog): string {
  return createHash("sha256")
    .update(JSON.stringify([waits, dialog]))
    .digest("hex")
    .slice(0, 16);
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
  /** `null` in the projects folder: the supervisor (ADR-58) or a free session (ADR-100). */
  repo: string | null;
  supervisor: boolean;
  /** The task in whose worktree the session runs; `null` in the repo root. */
  task: string | null;
  cols: number;
  rows: number;
  /** The session's `hooks.jsonl`, where the daemon appends the hooks the session plugin POSTs (ADR-88). */
  hooksFile: string;
  /** Copilot CLI got the prompt as its first message (`--interactive`), so it works right after the start. */
  promptOnStart: boolean;
  /** Copilot CLI already keeps a conversation under the session's id (a first message, or a resumed conversation; ADR-95). */
  hasConversation: boolean;
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
  /** The daemon's prompt, read just before, went to the agent: typed, typed again or as a block (not as context, ADR-85). */
  onPromptSent: () => void;
  /** Called synchronously, from whichever call read the change (hooks are read on every input and state read). */
  onEvent: (event: SessionEvent) => void;
}

export class LiveSession {
  readonly id: string;
  readonly repo: string | null;
  readonly supervisor: boolean;
  readonly task: string | null;
  readonly startedAt = new Date().toISOString();
  readonly #run: () => RunState | undefined;
  readonly #promptText: () => string | undefined;
  readonly #onUserText: () => void;
  readonly #onPromptSent: () => void;
  readonly #onEvent: (event: SessionEvent) => void;
  readonly #screen: TerminalScreen;
  readonly #state: CopilotSessionState;
  readonly #hooks: HookTail;
  readonly #decoder = new TextDecoder();
  #terminal: SessionPty | undefined;
  #last: TaskStateChange | null = null;
  readonly #attention = new SessionAttention();
  #finished = false;
  #hasConversation: boolean;
  readonly #closers = new Set<() => void>();
  /** The daemon's prompt was asked for (`askToRead`) and goes in once the session waits in its input box. */
  #promptAsked = false;
  /**
   * The daemon's prompt typed and not yet taken: it counts until the session leaves `Input`. `at` is when it was typed or
   * last tried again, `retries` how often it was tried again (Enter again or typed again).
   */
  #promptTyped: { text: string; at: number; retries: number } | undefined;
  /** The user typed or pasted since their last message was submitted, so the input box may hold their unsent text. */
  #userDraft = false;
  /** When the user last put text into the input box (milliseconds since the epoch). */
  #userTextAt = 0;
  /** The prompt last given to the agent with a tool's result in this turn (ADR-85), so it is given once per turn. */
  #contextGiven: string | undefined;
  /** The last turn's end was blocked with the prompt (ADR-85), so the turn under way is the daemon's. */
  #blockGiven = false;
  /** Since when the screen has shown the empty input box without a break, read once per read cycle. */
  #boxEmptySince: number | undefined;
  /** The input box's text read from the screen (`promptBoxText`), for the screen revision it was read at. */
  #boxRead: { revision: number; text: string | undefined } | undefined;
  /** The user put text into the input box or pressed Esc since the last end of a turn: the next end is of their turn. */
  #userDrove = false;
  #submitTimer: NodeJS.Timeout | undefined;
  /** Counts the waits for a dialog (each entry into `Approval` or `Input`), so the same request asked again gets a new id. */
  #waits = 0;
  /** The dialog last read, for the screen revision and wait it was read at: the screen is read once per change. */
  #dialogRead:
    | { revision: number; waits: number; kind: AgentDialog["kind"]; notice: string | undefined; dialog: AgentDialog | null }
    | undefined;
  /** The text of the last hook if it was an approval request ("Use MCP tool: …"): the heading of an approval box cut above. */
  #notice: string | undefined;
  /**
   * The user answered an approval Copilot CLI drew before its hook reached the daemon (ADR-71): when that hook comes,
   * the answer it already got moves the session on, as the key would have in `Approval`.
   */
  #answeredEarly = false;

  constructor(o: LiveSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.supervisor = o.supervisor;
    this.task = o.task;
    this.#run = o.run;
    this.#promptText = o.prompt;
    this.#onUserText = o.onUserText;
    this.#onPromptSent = o.onPromptSent;
    this.#onEvent = o.onEvent;
    this.#hasConversation = o.hasConversation;
    this.#state = new CopilotSessionState({
      now: Date.now,
      staleAfterMs: STALE_AFTER_MS,
      promptOnStart: o.promptOnStart,
      program: o.program,
    });
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
    // After the hooks already written, so that an end of a turn read now does not let a prompt join the user's text.
    // The answer to the agent's question (on the screen in `Input`, ADR-66) leaves nothing in the input box either.
    const key = sessionKey(data);
    const answersEarly = key !== undefined && this.#answersApprovalOnScreen(key);
    if (answersEarly) this.#answeredEarly = true;
    if (writesText(data, this.#last?.state) && this.#dialog() === null && !answersEarly) {
      this.#userDraft = true;
      this.#userTextAt = Date.now();
      this.#userDrove = true;
      this.#onUserText();
    }
    if (data === ESCAPE) this.#userDrove = true;
    if (key) this.#report(this.#state.key(key));
    // After the key's own state change, so that the `Input` an Esc causes counts as seen.
    if (typedByUser(data)) this.#attention.typed();
  }

  /**
   * Asks the session to read what waits for it (ADR-62, ADR-68): the daemon types its prompt (`prompt`, read at that
   * moment) at once while the session waits in its input box (`CopilotSessionState.inPromptBox`, ADR-69), otherwise as soon as it does again.
   * Never in the middle of a turn, in an approval or a question dialog, after the user's Esc or into text the user is
   * typing. One prompt at a time: while a typed one has not been taken, a request it already covers (the same text)
   * changes nothing, since the prompt asks to read everything unread; one it does not cover goes in after the next turn.
   * A typed prompt not taken within `RETYPE_AFTER_MS` is looked after by `tick` (`#followTypedPrompt`).
   */
  askToRead(): "typed" | "queued" {
    this.#readHooks();
    if (this.#promptTyped && this.#promptTyped.text === this.#promptText()) return "typed";
    this.#promptAsked = true;
    this.#typePrompt();
    return this.#promptAsked ? "queued" : "typed";
  }

  /**
   * The output for a hook Copilot CLI just sent (ADR-85), whose record (`undefined`: none) is already in `hooks.jsonl`:
   * what `askToRead` asked for goes to the agent without typing (`hookOutputFor`), so a new supervisor or main session
   * is not handed the updates it found unread. A block is the prompt on its way, like a typed one, and is the daemon's
   * turn: the turn it ends is not reported as ended. A turn a block started that ends with the prompt still unread
   * leaves it to the typed prompt once the input box is back. No dialog check as in `#typePrompt`: a block sends no keys.
   */
  hookOutput(record: CopilotHookRecord | undefined): CopilotHookOutput {
    // The hooks file is closed once the exit was seen; a late hook changes nothing.
    if (this.#finished) return {};
    const turnEnded = this.#readHooks(record?.event === "agentStop");
    const blockedTurn = record?.payload.stop_hook_active === true;
    const asked = this.#promptAsked || this.#promptTyped !== undefined || (blockedTurn && this.#blockGiven);
    if (record?.event === "agentStop") this.#blockGiven = false;
    const output =
      record === undefined || !asked
        ? {}
        : hookOutputFor({
            event: record.event,
            blockedTurn,
            prompt: this.#promptText(),
            contextGiven: this.#contextGiven,
            userDraft: this.#userDraft,
          });
    if ("additionalContext" in output) this.#contextGiven = output.additionalContext;
    if ("reason" in output) {
      this.#promptSent(output.reason, 0);
      this.#blockGiven = true;
    } else {
      if (blockedTurn && asked && this.#promptText() !== undefined) this.#promptAsked = true;
      if (turnEnded) this.#onEvent({ kind: "turn_ended" });
    }
    return output;
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
   * Copilot CLI keeps a conversation under the session's id, so `--resume=<id>` can go on with it (ADR-95): Copilot CLI
   * keeps none for a session that never had a prompt, and refuses to resume it.
   */
  get hasConversation(): boolean {
    return this.#hasConversation;
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
    this.#settleUserDraft();
    this.#followTypedPrompt();
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
      supervisor: this.supervisor,
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

  /** The agent dialog of `kind` the screen shows now, whatever the state; read once per screen image and wait. */
  #dialogOnScreen(kind: AgentDialog["kind"]): AgentDialog | null {
    if (this.#finished) return null;
    const revision = this.#screen.revision;
    const read = this.#dialogRead;
    const notice = this.#notice;
    if (read?.revision === revision && read.waits === this.#waits && read.kind === kind && read.notice === notice) return read.dialog;
    const found = readAgentDialog(this.#screen.lines(), kind, notice);
    const dialog = found ? { ...found, id: dialogId(this.#waits, found) } : null;
    this.#dialogRead = { revision, waits: this.#waits, kind, notice, dialog };
    return dialog;
  }

  /**
   * A digit or Enter in the middle of a turn while Copilot CLI already shows an approval whose hook has not reached the
   * daemon yet (ADR-71): the state is still `Working`, but the key answers the approval and leaves nothing in the input
   * box. Only mid-turn, so a message the user starts with a digit in the input box is still their text.
   */
  #answersApprovalOnScreen(key: SessionKey): boolean {
    const state = this.#last?.state;
    return answersDialog(key) && (state === "Working" || state === "Stale") && this.#dialogOnScreen("approval") !== null;
  }

  dispose(): void {
    if (!this.#finished) this.#hooks.close();
    this.#finished = true;
    clearTimeout(this.#submitTimer);
    for (const close of this.#closers) close();
    this.#closers.clear();
    this.#screen.dispose();
  }

  /**
   * Reads new hook records. A turn's end goes out as `turn_ended` at once, except the last record's when `holdLastTurnEnd`:
   * then the result says whether it ended a turn, for `hookOutput` to report after it decided on a block.
   */
  #readHooks(holdLastTurnEnd = false): boolean {
    const records = this.#hooks.read();
    const last = holdLastTurnEnd ? records.pop() : undefined;
    for (const record of records) if (this.#readHook(record)) this.#onEvent({ kind: "turn_ended" });
    return last !== undefined && this.#readHook(last);
  }

  /** Applies one hook record; true when it ended a turn the user did not drive. */
  #readHook(record: CopilotHookRecord): boolean {
    if (record.event === "userPromptSubmitted") {
      this.#userDraft = false;
      this.#hasConversation = true;
    }
    if (record.event === "userPromptSubmitted" || record.event === "agentStop") this.#contextGiven = undefined;
    this.#notice = approvalRequest(record) ? record.payload.message : undefined;
    this.#report(this.#state.hook(record));
    this.#applyEarlyAnswer(record.event);
    // The end of a turn from its hook, not from the state: a question dialog and an Esc give `Input` mid-turn too.
    if (record.event !== "agentStop") return false;
    const ended = !this.#userDrove;
    this.#userDrove = false;
    return ended;
  }

  /**
   * The approval's hook after the user already answered it (ADR-71) would leave the session in `Approval` until the
   * command ends, so the answer counts now. Any other hook of the turn means the answer went to no approval of record.
   */
  #applyEarlyAnswer(event: CopilotHookEvent): void {
    if (!this.#answeredEarly) return;
    if (this.#last?.state === "Approval") this.#report(this.#state.key("choice"));
    else if (event === "notification") return;
    this.#answeredEarly = false;
  }

  /** Until the session has a state, its screen may show the input box of a new session (ADR-69). */
  #readPromptBox(): void {
    if (this.#last === null) this.#report(this.#state.screen(() => this.#screen.lines()));
  }

  #report(changes: readonly (TaskStateChange | undefined)[]): void {
    for (const change of changes) {
      if (!change) continue;
      this.#attention.changed(this.#last?.state, change.state);
      if (change.state !== this.#last?.state && DIALOG_IN_STATE.has(change.state)) this.#waits++;
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
    this.#type(terminal, text, 0);
  }

  /**
   * The prompt `text` (try number `retries`) is on its way, typed or as a block: it counts until the session leaves
   * `Input`, and the read cycle looks after it from now (`#followTypedPrompt`).
   */
  #promptSent(text: string, retries: number): void {
    // Before the first hook a block cannot come (no `agentStop` yet), so `promptTyped` acts only for a typed prompt.
    this.#promptAsked = false;
    this.#promptTyped = { text, at: Date.now(), retries };
    this.#state.promptTyped();
    // The daemon starts this turn: an Esc earlier (an interrupt gives no `agentStop`) does not make it the user's.
    this.#userDrove = false;
    this.#onPromptSent();
  }

  /** Types `text` (try number `retries`) with its Enter after `SUBMIT_DELAY_MS`. */
  #type(terminal: SessionPty, text: string, retries: number): void {
    this.#promptSent(text, retries);
    terminal.write(text);
    clearTimeout(this.#submitTimer);
    this.#submitTimer = setTimeout(() => {
      if (!this.#finished) terminal.write("\r");
    }, SUBMIT_DELAY_MS);
    this.#submitTimer.unref();
  }

  /**
   * A typed prompt the session has not taken after `RETYPE_AFTER_MS` (ADR-68): still in the input box, it gets Enter
   * again; gone from an empty box, it was lost and is typed again, read anew. After `DELIVERY_RETRIES` tries the daemon
   * gives up until the next `askToRead`; text in the box that is not the prompt (or a prompt given up on in it) is
   * left alone, and the prompt goes in once the box is empty. While the screen shows no box (Copilot CLI busy, or still
   * holding keys it has not drawn) it waits, so a prompt that shows up in the box later still gets its Enter. The user's
   * own text is never submitted.
   */
  #followTypedPrompt(): void {
    const typed = this.#promptTyped;
    const terminal = this.#terminal;
    if (!typed || !terminal || this.#finished || this.#userDraft) return;
    if (Date.now() - typed.at <= RETYPE_AFTER_MS) return;
    const box = this.#box();
    if (box === undefined) return;
    const text = this.#promptText();
    if (text === undefined) this.#promptTyped = undefined;
    else if (box !== "" && (typed.retries >= DELIVERY_RETRIES || !holdsPrompt(box, typed.text))) this.#askAgain();
    else if (typed.retries >= DELIVERY_RETRIES) this.#promptTyped = undefined;
    else if (box !== "") {
      this.#promptTyped = { ...typed, at: Date.now(), retries: typed.retries + 1 };
      terminal.write("\r");
    } else if (this.#dialog() === null) this.#type(terminal, text, typed.retries + 1);
  }

  /** The typed prompt no longer counts; it goes in again once the session waits in its empty input box. */
  #askAgain(): void {
    this.#promptTyped = undefined;
    this.#promptAsked = true;
  }

  /**
   * The user's draft is gone once the input box has stayed empty for `USER_DRAFT_SETTLE_MS`, counted from their last
   * text: cleared with Ctrl+C, sent as a slash command, or taken into a running turn, none of which sends
   * `userPromptSubmitted`.
   */
  #settleUserDraft(): void {
    const now = Date.now();
    if (this.#box() !== "") this.#boxEmptySince = undefined;
    else this.#boxEmptySince ??= now;
    const emptySince = this.#boxEmptySince;
    if (this.#userDraft && emptySince !== undefined && now - Math.max(emptySince, this.#userTextAt) > USER_DRAFT_SETTLE_MS)
      this.#userDraft = false;
  }

  /** The input box's text on the screen now (`promptBoxText`), read once per screen image. */
  #box(): string | undefined {
    const revision = this.#screen.revision;
    if (this.#boxRead?.revision !== revision) this.#boxRead = { revision, text: promptBoxText(this.#screen.lines()) };
    return this.#boxRead.text;
  }
}

/** Whether the input box's text is (the start of) the prompt the daemon typed, whatever the wrapping did to blanks. */
function holdsPrompt(box: string, prompt: string): boolean {
  const compact = (text: string) => text.replace(/\s/g, "");
  return compact(prompt).startsWith(compact(box));
}
