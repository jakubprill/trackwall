import type { TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import { stateFromHook } from "./copilot-hooks.ts";
import { answersDialog, type SessionKey, stateFromKey } from "./copilot-keys.ts";
import { stateFromOsc, windowTitleFromOsc } from "./copilot-osc.ts";
import { promptBoxOnScreen, stateFromPromptBox } from "./copilot-prompt-box.ts";
import { CopilotScreen } from "./copilot-screen.ts";
import { OscParser } from "./osc-parser.ts";
import { type StateSignal, TaskStateTracker, type TaskStateTrackerOptions } from "./task-state-tracker.ts";

/**
 * The first `sessionStart` of a session with a prompt on its way (`--interactive`, or one the daemon typed): Copilot
 * CLI 1.0.103 sends it together with the first prompt (ADR-17, ADR-69), so here it starts work. Without a known prompt
 * it stays waiting for you, since `/resume` or `/clear` as the first command may send it too.
 */
const SESSION_START_WITH_PROMPT: StateSignal = {
  state: "Working",
  source: "hook",
  confidence: "medium",
  reason: "hook sessionStart with a prompt",
};

/**
 * A prompt the daemon typed counts as on its way this long (ADR-62): its session is not waiting for you meanwhile, and
 * one not taken by then may be typed again into an empty input box.
 */
export const RETYPE_AFTER_MS = 5000;

/**
 * The interrupted turn message counts only this long after an answer with a key: the same text comes back on the screen
 * when the history is redrawn, e.g. after a resize.
 */
const CANCEL_AFTER_ANSWER_MS = 10_000;

/**
 * While other approval requests still wait after an answer (ADR-66), the message counts only this soon after the key,
 * which it follows at once: later the same text may be output of the approved tool, and it would end waiting for the rest.
 */
const CANCEL_WHILE_WAITING_MS = 2000;

/**
 * How long a `postToolUse` that came while an approval request waits is held back (ADR-66): it may be of a tool called
 * together with the one asking, whose dialog the screen shows a moment later (`approvalOnScreen`), or the request was
 * answered in a way the daemon did not see, and the work goes on.
 */
const HOLD_TOOL_USE_MS = 3000;

/**
 * The state of one Copilot CLI session (§4.4): PTY output, hook records and a human's keys go in, state changes come
 * out. The same object computes the state live and when replaying a recording, so a test on a recording checks what
 * runs in the session. The screen image (`screen`) comes only live: a recording has none, so its replay of a new session
 * has no state until the first hook (ADR-69).
 */
export interface CopilotSessionStateOptions extends TaskStateTrackerOptions {
  /**
   * The session starts with the prompt as its first message (`--interactive`, the session of a new task, ADR-31), so its
   * first `sessionStart` starts work, and its input box on the screen before it is not waiting for you. Without this a
   * task session would be waiting for you for a moment, and `wait_for_session` (ADR-39) would end the wait before the
   * agent starts.
   */
  promptOnStart: boolean;
  /**
   * The path the session's program was started with, whose window title ConPTY on Windows sets first (`windowTitleFromOsc`);
   * `null` when not known, as in the replay of a recording.
   */
  program: string | null;
}

export class CopilotSessionState {
  readonly #osc = new OscParser();
  readonly #screen = new CopilotScreen();
  readonly #tracker: TaskStateTracker;
  readonly #now: () => number;
  readonly #promptOnStart: boolean;
  readonly #program: string | null;
  /** When the daemon typed a prompt before the first hook (`promptTyped`). */
  #promptTypedAt: number | undefined;
  /**
   * Whether the last hook record that changed the state left Copilot CLI in its input box: after the end of a turn and
   * a `sessionStart` without a prompt; `undefined` before one.
   */
  #inPromptBox: boolean | undefined;
  #windowTitle: string | undefined;
  /** The time of the last session key that changed the state (an answer to a request or an interruption). */
  #lastAnswerAt = Number.NEGATIVE_INFINITY;
  /**
   * Approval requests of the current wait in `Approval` not answered yet; it starts with each entry into `Approval`.
   * Copilot CLI 1.0.103 asks for the approvals of tools the agent called at once all together, with a hook each, and
   * then shows their dialogs one at a time (ADR-66), so answering one leaves the session waiting while others remain.
   */
  #approvalsAsked = 0;
  /** A `postToolUse` held back while an approval request waits, and when it came. */
  #heldToolUse: { signal: StateSignal; at: number } | undefined;

  constructor(o: CopilotSessionStateOptions) {
    this.#tracker = new TaskStateTracker(o);
    this.#now = o.now;
    this.#promptOnStart = o.promptOnStart;
    this.#program = o.program;
  }

  /** The last window title set by Copilot CLI: what the agent is working on. */
  get windowTitle(): string | undefined {
    return this.#windowTitle;
  }

  /**
   * Every input and the end of the process first check the `Stale` threshold. The replay has no periodic `tick`, so this
   * way it gives the same order of changes as the live session.
   */
  output(data: string): TaskStateChange[] {
    const changes = [this.#tick(), this.#tracker.activity()];
    for (const osc of this.#osc.feed(data)) {
      this.#windowTitle = windowTitleFromOsc(osc, this.#program) ?? this.#windowTitle;
      const signal = stateFromOsc(osc);
      if (signal) changes.push(this.#tracker.signal(signal));
    }
    const cancelled = this.#screen.feed(data);
    // After an answer to one of several approval requests the session is still in `Approval` (ADR-66), which a weaker
    // source could not end; the message right after the key says the key ended the turn.
    const waiting = this.#tracker.current?.state === "Approval";
    const sinceAnswer = this.#now() - this.#lastAnswerAt;
    if (cancelled && waiting && sinceAnswer <= CANCEL_WHILE_WAITING_MS) changes.push(this.#tracker.causedByKey(cancelled));
    else if (cancelled && !waiting && sinceAnswer <= CANCEL_AFTER_ANSWER_MS) changes.push(this.#tracker.signal(cancelled));
    return changes.filter((c) => c !== undefined);
  }

  /**
   * A `postToolUse` while an approval request is not answered is held back for `HOLD_TOOL_USE_MS`: it may be of a tool
   * called together with the one asking (one that needed no approval, or one of several already approved, ADR-66).
   * Only an `Approval` guessed from a notification's text, no request of a known kind, ends with it at once as before.
   */
  hook(record: CopilotHookRecord): TaskStateChange[] {
    const waiting = this.#tracker.current?.state === "Approval";
    const keepsWaiting = record.event === "postToolUse" && waiting && this.#approvalsAsked > 0;
    // The first `sessionStart`: no hook has changed the state yet.
    const withPrompt = record.event === "sessionStart" && this.#inPromptBox === undefined && this.#promptOnItsWay();
    const hookSignal = withPrompt ? SESSION_START_WITH_PROMPT : stateFromHook(record);
    if (keepsWaiting && hookSignal) this.#heldToolUse = { signal: hookSignal, at: this.#now() };
    else if (hookSignal) this.#heldToolUse = undefined;
    const signal = keepsWaiting ? undefined : hookSignal;
    if (signal) this.#inPromptBox = !withPrompt && (record.event === "sessionStart" || record.event === "agentStop");
    // Only a request of a known kind is counted; one guessed from the text may be no dialog at all.
    const asked = signal?.confidence === "high" ? 1 : 0;
    if (signal?.state === "Approval") this.#approvalsAsked = (waiting ? this.#approvalsAsked : 0) + asked;
    return this.#signal(signal);
  }

  /**
   * The screen shows an approval dialog the user has not answered: a held-back `postToolUse` is of a tool called
   * together with it, and the session keeps waiting for the answer.
   */
  approvalOnScreen(): void {
    this.#heldToolUse = undefined;
  }

  /**
   * Whether Copilot CLI waits in its empty input box, where the daemon may type a prompt for the user (ADR-62). The
   * state alone does not tell, since a question dialog, a guess from the screen and the user's Esc give `Input` too.
   * Before the first hook: while the screen shows the empty box now (ADR-69), not because it once did, since with
   * hooks that do not work the screen may show an approval by now; never while a prompt is on its way.
   */
  inPromptBox(lines: () => readonly string[]): boolean {
    if (this.#inPromptBox !== undefined) return this.#inPromptBox;
    return !this.#promptOnItsWay() && promptBoxOnScreen(lines()) === "empty";
  }

  /** The daemon typed a prompt into the session (ADR-62); before the first hook its `sessionStart` then starts work. */
  promptTyped(): void {
    if (this.#inPromptBox === undefined) this.#promptTypedAt = this.#now();
  }

  /** Before the first hook: the starting prompt, or one the daemon typed at most `RETYPE_AFTER_MS` ago. */
  #promptOnItsWay(): boolean {
    const typedAt = this.#promptTypedAt;
    return this.#promptOnStart || (typedAt !== undefined && this.#now() - typedAt <= RETYPE_AFTER_MS);
  }

  /**
   * The session's screen image (its visible lines): until the first state, the input box of a new session is waiting for
   * you (ADR-69). Copilot CLI sends its first hook only with the first prompt, so without this a new session would have
   * no state. Not while a prompt is on its way, so the session does not wait for you while its agent is about to start.
   */
  screen(lines: () => readonly string[]): TaskStateChange[] {
    if (this.#tracker.current !== undefined || this.#promptOnItsWay()) return [];
    return this.#signal(stateFromPromptBox(lines()));
  }

  #signal(signal: StateSignal | undefined): TaskStateChange[] {
    return [this.#tick(), signal && this.#tracker.signal(signal)].filter((c) => c !== undefined);
  }

  /** A key a human sent to the session terminal (`sessionKey`). */
  key(key: SessionKey): TaskStateChange[] {
    // The `Stale` threshold first: live, the periodic `tick` may already have set it, and the key counts from the state after it.
    const stale = this.#tick();
    const current = this.#tracker.current?.state;
    const signal = stateFromKey(key, current);
    if (!signal) return [stale].filter((c) => c !== undefined);
    this.#lastAnswerAt = this.#now();
    // An answer to one of several approval requests: the next one's dialog follows, so the session still waits (ADR-66).
    if (current === "Approval" && answersDialog(key) && this.#approvalsAsked > 1) {
      this.#approvalsAsked--;
      return [stale].filter((c) => c !== undefined);
    }
    return [stale, this.#tracker.keyboard(signal)].filter((c) => c !== undefined);
  }

  tick(): TaskStateChange | undefined {
    return this.#tick();
  }

  /** The `Stale` threshold, and a held-back `postToolUse` whose approval dialog the screen has not shown. */
  #tick(): TaskStateChange | undefined {
    const held = this.#heldToolUse;
    if (held === undefined || this.#now() - held.at < HOLD_TOOL_USE_MS) return this.#tracker.tick();
    this.#heldToolUse = undefined;
    return this.#tracker.current?.state === "Approval" ? this.#tracker.signal(held.signal) : this.#tracker.tick();
  }

  exit(code: number): TaskStateChange[] {
    return [this.#tick(), this.#tracker.exit(code)].filter((c) => c !== undefined);
  }
}
