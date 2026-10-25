import type { TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import { stateFromHook } from "./copilot-hooks.ts";
import { type SessionKey, stateFromKey } from "./copilot-keys.ts";
import { stateFromOsc, windowTitleFromOsc } from "./copilot-osc.ts";
import { CopilotScreen } from "./copilot-screen.ts";
import { OscParser } from "./osc-parser.ts";
import { type StateSignal, TaskStateTracker, type TaskStateTrackerOptions } from "./task-state-tracker.ts";

/** The `sessionStart` of a session that starts with a prompt (`promptOnStart`). */
const SESSION_START_WITH_PROMPT: StateSignal = {
  state: "Working",
  source: "hook",
  confidence: "medium",
  reason: "hook sessionStart with a prompt",
};

/**
 * The interrupted turn message counts only this long after an answer with a key: the same text comes back on the screen
 * when the history is redrawn, e.g. after a resize.
 */
const CANCEL_AFTER_ANSWER_MS = 10_000;

/**
 * The state of one Copilot CLI session (§4.4): PTY output, hook records and a human's keys go in, state changes come
 * out. The same object computes the state live and when replaying a recording, so a test on a recording checks what
 * runs in the session.
 */
export interface CopilotSessionStateOptions extends TaskStateTrackerOptions {
  /**
   * The session starts with the prompt as its first message (`--interactive`, the session of a new task, ADR-31), so
   * `sessionStart` means the start of work on the prompt, not waiting for you. Without this a task session would be
   * waiting for you for a moment between `sessionStart` and `userPromptSubmitted`, and `wait_for_session` (ADR-39) would
   * end the wait before the agent starts.
   */
  promptOnStart: boolean;
}

export class CopilotSessionState {
  readonly #osc = new OscParser();
  readonly #screen = new CopilotScreen();
  readonly #tracker: TaskStateTracker;
  readonly #now: () => number;
  /** The first `sessionStart` has not come yet; only it carries the prompt, `/clear` or `/resume` in the session no longer do. */
  #promptPending: boolean;
  #windowTitle: string | undefined;
  /** The time of the last session key that changed the state (an answer to a request or an interruption). */
  #lastAnswerAt = Number.NEGATIVE_INFINITY;

  constructor(o: CopilotSessionStateOptions) {
    this.#tracker = new TaskStateTracker(o);
    this.#now = o.now;
    this.#promptPending = o.promptOnStart;
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
    const withPrompt = this.#promptPending && record.event === "sessionStart";
    if (record.event === "sessionStart") this.#promptPending = false;
    const signal = withPrompt ? SESSION_START_WITH_PROMPT : stateFromHook(record);
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
