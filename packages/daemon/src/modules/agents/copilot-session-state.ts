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
   * Approval requests of the current wait not answered yet. Copilot CLI 1.0.103 asks for the approvals of tools the
   * agent called at once all together, with a hook each, and then shows their dialogs one at a time (ADR-66), so
   * answering one leaves the session waiting while others remain.
   */
  #approvalsAsked = 0;

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
    const changes = [this.#tracker.tick(), this.#tracker.activity()];
    for (const osc of this.#osc.feed(data)) {
      this.#windowTitle = windowTitleFromOsc(osc, this.#program) ?? this.#windowTitle;
      const signal = stateFromOsc(osc);
      if (signal) changes.push(this.#tracker.signal(signal));
    }
    const cancelled = this.#screen.feed(data);
    if (cancelled && this.#now() - this.#lastAnswerAt <= CANCEL_AFTER_ANSWER_MS) changes.push(this.#tracker.signal(cancelled));
    return this.#counted(changes);
  }

  /**
   * `approvalOnScreen` tells whether the screen shows an approval dialog the user has not answered: the `postToolUse`
   * of a tool that needed no approval, or of one of several approved, does not end waiting for one still on the screen
   * (ADR-66). A recording has no screen, so its replay passes `() => false`.
   */
  hook(record: CopilotHookRecord, approvalOnScreen: () => boolean): TaskStateChange[] {
    if (record.event === "postToolUse" && this.#tracker.current?.state === "Approval" && approvalOnScreen()) return this.#signal(undefined);
    // The first `sessionStart`: no hook has changed the state yet.
    const withPrompt = record.event === "sessionStart" && this.#inPromptBox === undefined && this.#promptOnItsWay();
    const signal = withPrompt ? SESSION_START_WITH_PROMPT : stateFromHook(record);
    if (signal) this.#inPromptBox = !withPrompt && (record.event === "sessionStart" || record.event === "agentStop");
    if (signal?.state === "Approval") this.#approvalsAsked++;
    return this.#signal(signal);
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
    return this.#counted([this.#tracker.tick(), signal && this.#tracker.signal(signal)]);
  }

  /** A key a human sent to the session terminal (`sessionKey`). */
  key(key: SessionKey): TaskStateChange[] {
    // The `Stale` threshold first: live, the periodic `tick` may already have set it, and the key counts from the state after it.
    const stale = this.#tracker.tick();
    const current = this.#tracker.current?.state;
    const signal = stateFromKey(key, current);
    if (!signal) return this.#counted([stale]);
    this.#lastAnswerAt = this.#now();
    // An answer to one of several approval requests: the next one's dialog follows, so the session still waits (ADR-66).
    if (current === "Approval" && answersDialog(key) && this.#approvalsAsked > 1) {
      this.#approvalsAsked--;
      return this.#counted([stale]);
    }
    return this.#counted([stale, this.#tracker.keyboard(signal)]);
  }

  tick(): TaskStateChange | undefined {
    return this.#counted([this.#tracker.tick()])[0];
  }

  exit(code: number): TaskStateChange[] {
    return this.#counted([this.#tracker.tick(), this.#tracker.exit(code)]);
  }

  /** The changes that happened; a session no longer in `Approval` has no approval request left to answer. */
  #counted(changes: readonly (TaskStateChange | undefined)[]): TaskStateChange[] {
    if (this.#tracker.current?.state !== "Approval") this.#approvalsAsked = 0;
    return changes.filter((c) => c !== undefined);
  }
}
