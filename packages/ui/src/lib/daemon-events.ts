import { DaemonEvent, type DaemonEventOf, type DaemonEventPayload, type DaemonEventType, EVENTS_SOCKET } from "@trackwall/protocol";
import type { Connection } from "./connection.ts";
import { daemonSocket } from "./daemon-socket.ts";

/**
 * Zdarzenia daemona z WebSocketu `/ws` (§5.2, ADR-36), jedno połączenie dla całego UI. Zdarzenie niesie całą
 * migawkę tematu, a daemon po każdym podłączeniu wysyła najpierw migawkę każdego tematu, więc po zerwanym połączeniu
 * wystarczy połączyć się ponownie. Widoki biorą temat jako `LiveFeed` (`useRemote` z opcją `live`) i odpytują HTTP
 * tylko wtedy, gdy temat nie ma świeżej migawki z bieżącego połączenia.
 */

/** Pierwsza przerwa przed ponownym połączeniem; kolejne rosną dwukrotnie do `MAX_RECONNECT_MS`. */
const RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 10_000;

/** Migawki jednego tematu na żywo. */
export interface LiveFeed<T> {
  /** Każda nowa migawka; ta z bieżącego połączenia od razu, jeśli już jest. Zwraca wypisanie. */
  subscribe(onData: (data: T) => void): () => void;
  /** Połączenie działa i przyszła już z niego migawka tematu, więc odpytywanie niczego nie doda. */
  isLive(): boolean;
}

/** To, czego klient potrzebuje od WebSocketu przeglądarki; w testach atrapa. */
export type EventSocket = Pick<WebSocket, "onopen" | "onmessage" | "onclose" | "close">;

export interface DaemonEventsOptions {
  conn: Connection;
  location: Pick<Location, "protocol" | "host">;
  openSocket: (url: string, protocols: string[]) => EventSocket;
}

export class DaemonEvents {
  readonly #o: DaemonEventsOptions;
  /** Migawki z bieżącego połączenia; po zerwaniu znikają, bo mogą być już stare. */
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
    // Jedyne rzutowanie: TypeScript nie wiąże pola `payload` zawężonego zdarzenia z parametrem `T` (dla `T` jako unii
    // typów byłoby to nawet niepoprawne), choć `ofType` sprawdził typ zdarzenia sparsowanego schematem `DaemonEvent`.
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
    // Zdarzenie niezgodne z kontraktem (inna wersja daemona) pomija się; temat zostaje na odpytywaniu.
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
