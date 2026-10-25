import type { TaskStateChange, TaskStateSource } from "@trackwall/protocol";

/**
 * Combines the signals of one task session's state detectors into one state (§4.4). The rules:
 *
 * - The best source that has spoken wins: after the first hook, terminal sequences and the screen no longer change the
 *   state, because the hook knows more. While the hook is silent (e.g. it does not work on a given system), the state
 *   comes from the weaker ones. Exception: a weaker source can end `Working`. When the end-of-turn hook does not come
 *   (lost, hook timeout exceeded, interrupted turn), the session does not hang in `Working` and then in `Stale` although
 *   it is waiting for a human.
 * - A human's key (`keyboard`) always gets through, because it tells what hooks do not report: an answer to an approval
 *   request and an interrupted turn. The key detector itself decides in which state a key means something (`copilot-keys.ts`).
 * - `Stale` only from `Working`: no output and no signals for the threshold. Waiting for a human is not hanging. The time
 *   and reason of `Stale` depend only on the last activity and the threshold, not on how often `tick` is called, so a live
 *   session and a replayed recording give the same result. Any output after `Stale` returns to the state before it.
 * - The end of the process is final; nothing changes the state afterwards. The exit code decides `Done` or `Error`,
 *   unless a detector has already reported the end of the session (`endsSession`), because that says more than the code.
 */

const DETECTOR_RANK = { screen: 1, osc: 2, hook: 3 } as const satisfies Partial<Record<TaskStateSource, number>>;

/** Signal sources of the detectors observing a session; `keyboard`, `timeout` and `exit` have their own methods. */
type DetectorSource = keyof typeof DETECTOR_RANK;

export type StateSignal = Omit<TaskStateChange, "at" | "source"> & {
  source: DetectorSource;
  /** An end-of-session signal (e.g. the `sessionEnd` hook); the process exit code no longer changes it. */
  endsSession?: true;
};

/** A human's key in the session terminal (`copilot-keys.ts`). */
export type KeyboardSignal = Omit<TaskStateChange, "at" | "source"> & { source: "keyboard" };

type TrackedState = Omit<TaskStateChange, "at">;

export interface TaskStateTrackerOptions {
  now: () => number;
  /** After this many milliseconds without output and signals `Working` turns into `Stale`. */
  staleAfterMs: number;
}

export class TaskStateTracker {
  readonly #now: () => number;
  readonly #staleAfterMs: number;
  #current: TaskStateChange | undefined;
  #beforeStale: TrackedState | undefined;
  #bestRank = 0;
  #lastActivity: number;
  #sessionEnded = false;
  #exited = false;

  constructor(o: TaskStateTrackerOptions) {
    this.#now = o.now;
    this.#staleAfterMs = o.staleAfterMs;
    this.#lastActivity = o.now();
  }

  get current(): TaskStateChange | undefined {
    return this.#current;
  }

  /** A detector signal; returns a change when the state, source or confidence differs from before. */
  signal({ endsSession, ...s }: StateSignal): TaskStateChange | undefined {
    const rank = DETECTOR_RANK[s.source];
    const endsWork = this.#current?.state === "Working" && s.state !== "Working";
    if (this.#exited || (rank < this.#bestRank && !endsWork)) return undefined;
    this.#bestRank = Math.max(this.#bestRank, rank);
    this.#sessionEnded ||= endsSession === true;
    this.#lastActivity = this.#now();
    return this.#set(s, this.#lastActivity);
  }

  /** A human's key: without source ranking, because it tells what hooks do not report. */
  keyboard(s: KeyboardSignal): TaskStateChange | undefined {
    if (this.#exited) return undefined;
    this.#lastActivity = this.#now();
    return this.#set(s, this.#lastActivity);
  }

  /** The session printed something. */
  activity(): TaskStateChange | undefined {
    this.#lastActivity = this.#now();
    if (this.#exited || this.#current?.state !== "Stale" || !this.#beforeStale) return undefined;
    return this.#set(this.#beforeStale, this.#lastActivity);
  }

  /** Called periodically; returns a change to `Stale` when the threshold has passed. */
  tick(): TaskStateChange | undefined {
    const current = this.#current;
    if (this.#exited || current?.state !== "Working") return undefined;
    const staleAt = this.#lastActivity + this.#staleAfterMs;
    if (this.#now() < staleAt) return undefined;
    const { at: _, ...working } = current;
    this.#beforeStale = working;
    const reason = `no output for ${this.#staleAfterMs / 1000} s`;
    return this.#set({ state: "Stale", source: "timeout", confidence: "medium", reason }, staleAt);
  }

  /** The session's process has ended. */
  exit(code: number): TaskStateChange | undefined {
    if (this.#exited) return undefined;
    this.#exited = true;
    if (this.#sessionEnded) return undefined;
    const state = code === 0 ? "Done" : "Error";
    return this.#set({ state, source: "exit", confidence: "exact", reason: `exit code ${code}` }, this.#now());
  }

  #set(s: TrackedState, at: number): TaskStateChange | undefined {
    const c = this.#current;
    if (c && c.state === s.state && c.source === s.source && c.confidence === s.confidence) return undefined;
    this.#current = { ...s, at: new Date(at).toISOString() };
    return this.#current;
  }
}
