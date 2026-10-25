import { DaemonEvent, type DaemonEventOf, type DaemonEventPayload, type DaemonEventType, EVENTS_SOCKET } from "@trackwall/protocol";
import type { Connection } from "./connection.ts";
import { daemonSocket } from "./daemon-socket.ts";

/**
 * Daemon events from the `/ws` WebSocket (§5.2, ADR-36), one connection for the whole UI. An event carries the whole
 * topic snapshot, and after every connection the daemon first sends the snapshot of every topic, so after a dropped
 * connection it is enough to reconnect. Views take a topic as a `LiveFeed` (`useRemote` with the `live` option) and poll
 * HTTP only when the topic has no fresh snapshot from the current connection.
 */

/** The first pause before reconnecting; the next ones double up to `MAX_RECONNECT_MS`. */
const RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 10_000;

/** Live snapshots of one topic. */
export interface LiveFeed<T> {
  /** Every new snapshot; the one from the current connection at once, if there already is one. Returns the unsubscribe. */
  subscribe(onData: (data: T) => void): () => void;
  /** The connection works and a snapshot of the topic has already arrived over it, so polling would add nothing. */
  isLive(): boolean;
}

/** What the client needs from the browser WebSocket; a fake in tests. */
export type EventSocket = Pick<WebSocket, "onopen" | "onmessage" | "onclose" | "close">;

export interface DaemonEventsOptions {
  conn: Connection;
  location: Pick<Location, "protocol" | "host">;
  openSocket: (url: string, protocols: string[]) => EventSocket;
}

export class DaemonEvents {
  readonly #o: DaemonEventsOptions;
  /** Snapshots from the current connection; they go after a disconnect, because they may already be stale. */
  readonly #latest = new Map<DaemonEventType, DaemonEvent>();
  readonly #listeners = new Set<(event: DaemonEvent) => void>();
  #socket: EventSocket | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #delay = RECONNECT_MS;
  #closed = false;

  constructor(o: DaemonEventsOptions) {
    this.#o = o;
    this.#connect();
  }

  feed<T extends DaemonEventType>(type: T): LiveFeed<DaemonEventPayload<T>> {
    const ofType = (event: DaemonEvent | undefined): event is DaemonEventOf<T> => event?.type === type;
    // The only cast: TypeScript does not tie the `payload` field of the narrowed event to the parameter `T` (for `T` as a
    // union of types it would even be unsound), although `ofType` checked the type of the event parsed with the `DaemonEvent` schema.
    const payloadOf = (event: DaemonEventOf<T>) => event.payload as DaemonEventPayload<T>;
    return {
      subscribe: (onData) => {
        const listener = (event: DaemonEvent) => {
          if (ofType(event)) onData(payloadOf(event));
        };
        this.#listeners.add(listener);
        const latest = this.#latest.get(type);
        if (ofType(latest)) onData(payloadOf(latest));
        return () => {
          this.#listeners.delete(listener);
        };
      },
      isLive: () => this.#latest.has(type),
    };
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#socket?.close();
  }

  #connect(): void {
    const { url, protocols } = daemonSocket(this.#o.conn, EVENTS_SOCKET, this.#o.location);
    const socket = this.#o.openSocket(url, protocols);
    this.#socket = socket;
    socket.onopen = () => {
      this.#delay = RECONNECT_MS;
    };
    socket.onmessage = (event: MessageEvent<unknown>) => this.#receive(event.data);
    socket.onclose = () => {
      this.#latest.clear();
      if (this.#closed) return;
      this.#timer = setTimeout(() => this.#connect(), this.#delay);
      this.#delay = Math.min(this.#delay * 2, MAX_RECONNECT_MS);
    };
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    const event = DaemonEvent.safeParse(parseJson(data));
    // An event that does not match the contract (another daemon version) is skipped; the topic stays on polling.
    if (!event.success) return;
    this.#latest.set(event.data.type, event.data);
    for (const listener of this.#listeners) listener(event.data);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
