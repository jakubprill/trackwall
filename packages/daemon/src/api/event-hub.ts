import type { DaemonEvent, DaemonEventOf, DaemonEventType } from "@trackwall/protocol";
import type { Facade } from "../facade.ts";

/**
 * The source of `/ws` events (§5.2, ADR-36): topic snapshots from the facade, compared every `CHECK_MS` while someone listens.
 * A changed snapshot goes to all listeners as an event, and a new listener first gets the latest snapshot of
 * every topic. Comparing instead of notifications from modules: a session's state changes in many places (hooks, OSC,
 * keys, the `Stale` threshold, the end of a group in `procs`), and a snapshot is a read from the daemon's memory, so one
 * comparison does not lose a change a module would forget to notify about.
 */

/** The same as the session cycle (`TICK_MS` in `agents`), from which new hook records come. */
const CHECK_MS = 200;

/** The snapshot read of every topic; a topic from `DaemonEvent` missing here is a compile error. */
const TOPICS: { [T in DaemonEventType]: (facade: Facade) => DaemonEventOf<T> } = {
  "sessions.changed": (facade) => ({ type: "sessions.changed", payload: facade.agents.sessionsAsOfLastCycle() }),
  "mise.running.changed": (facade) => ({ type: "mise.running.changed", payload: facade.mise.running() }),
  "repos.changed": (facade) => ({ type: "repos.changed", payload: facade.repoWatch.state() }),
  "cards.warmup.changed": (facade) => ({ type: "cards.warmup.changed", payload: facade.cards.warmupProgress() }),
  "board.changed": (facade) => ({ type: "board.changed", payload: { revision: facade.board.revision() } }),
};

export interface EventListener {
  /** The event as a ready JSON frame, serialised once for all listeners. */
  event: (frame: string) => void;
  /**
   * A topic whose snapshot the listener already got can no longer be read: its snapshot is out of date and no new one
   * will come, so the listener must stop treating it as live state.
   */
  topicFailed: () => void;
}

export interface EventHubOptions {
  facade: Facade;
  log: (msg: string) => void;
}

export class EventHub {
  readonly #o: EventHubOptions;
  readonly #listeners = new Set<EventListener>();
  /** The last frame and snapshot as JSON, by type; a topic that cannot be read is not here. */
  readonly #latest = new Map<DaemonEventType, { frame: string; json: string }>();
  /** The last error reading a topic, so that the same error every cycle does not flood the log. */
  readonly #failures = new Map<DaemonEventType, string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(o: EventHubOptions) {
    this.#o = o;
  }

  /** A listener gets the snapshot of every topic at once, then every change; returns the unsubscribe. */
  subscribe(listener: EventListener): () => void {
    this.#check();
    for (const { frame } of this.#latest.values()) listener.event(frame);
    this.#listeners.add(listener);
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#check(), CHECK_MS);
      this.#timer.unref();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.close();
    };
  }

  /** The end of comparing; listeners that remain get no more events. */
  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #check(): void {
    for (const type of Object.keys(TOPICS) as DaemonEventType[]) {
      const event = this.#read(type);
      if (!event) continue;
      const json = JSON.stringify(event.payload);
      if (this.#latest.get(type)?.json === json) continue;
      const frame = JSON.stringify(event);
      this.#latest.set(type, { frame, json });
      for (const listener of this.#listeners) listener.event(frame);
    }
  }

  #read(type: DaemonEventType): DaemonEvent | undefined {
    try {
      const event = TOPICS[type](this.#o.facade);
      this.#failures.delete(type);
      return event;
    } catch (err) {
      const message = String(err);
      if (this.#failures.get(type) !== message) this.#o.log(`reading ${type} for events: ${message}`);
      this.#failures.set(type, message);
      if (this.#latest.delete(type)) for (const listener of this.#listeners) listener.topicFailed();
      return undefined;
    }
  }
}
