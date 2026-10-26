import type { TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import { stateFromHook } from "./copilot-hooks.ts";
import { type SessionKey, stateFromKey } from "./copilot-keys.ts";
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
}

export class CopilotSessionState {
  readonly #osc = new OscParser();
  readonly #screen = new CopilotScreen();
  readonly #tracker: TaskStateTracker;
  readonly #now: () => number;
  readonly #promptOnStart: boolean;
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

  constructor(o: CopilotSessionStateOptions) {
    this.#tracker = new TaskStateTracker(o);
    this.#now = o.now;
    this.#promptOnStart = o.promptOnStart;
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
      this.#windowTitle = windowTitleFromOsc(osc) ?? this.#windowTitle;
      const signal = stateFromOsc(osc);
      if (signal) changes.push(this.#tracker.signal(signal));
    }
    const cancelled = this.#screen.feed(data);
    if (cancelled && this.#now() - this.#lastAnswerAt <= CANCEL_AFTER_ANSWER_MS) changes.push(this.#tracker.signal(cancelled));
    return changes.filter((c) => c !== undefined);
  }

  hook(record: CopilotHookRecord): TaskStateChange[] {
    // The first `sessionStart`: no hook has changed the state yet.
    const withPrompt = record.event === "sessionStart" && this.#inPromptBox === undefined && this.#promptOnItsWay();
    const signal = withPrompt ? SESSION_START_WITH_PROMPT : stateFromHook(record);
    if (signal) this.#inPromptBox = !withPrompt && (record.event === "sessionStart" || record.event === "agentStop");
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
    return [this.#tracker.tick(), signal && this.#tracker.signal(signal)].filter((c) => c !== undefined);
  }

  /** A key a human sent to the session terminal (`sessionKey`). */
  key(key: SessionKey): TaskStateChange[] {
    // The `Stale` threshold first: live, the periodic `tick` may already have set it, and the key counts from the state after it.
    const stale = this.#tracker.tick();
    const signal = stateFromKey(key, this.#tracker.current?.state);
    if (!signal) return [stale].filter((c) => c !== undefined);
    this.#lastAnswerAt = this.#now();
    return [stale, this.#tracker.keyboard(signal)].filter((c) => c !== undefined);
  }

  tick(): TaskStateChange | undefined {
    return this.#tracker.tick();
  }

  exit(code: number): TaskStateChange[] {
    return [this.#tracker.tick(), this.#tracker.exit(code)].filter((c) => c !== undefined);
  }
}
