import type { DaemonEvent } from "@trackwall/protocol";
import type { Facade } from "../facade.ts";

/**
 * Źródło zdarzeń `/ws` (§5.2, ADR-36): migawki tematów z fasady, porównywane co `CHECK_MS`, dopóki ktoś słucha.
 * Zmieniona migawka idzie do wszystkich słuchaczy jako zdarzenie z kolejnym `seq`, a nowy słuchacz dostaje najpierw
 * najnowszą migawkę każdego tematu. Porównanie zamiast powiadomień z modułów: stan sesji zmienia się w wielu miejscach
 * (hooki, OSC, klawisze, próg `Stale`, koniec grupy w `procs`), a migawka to odczyt z pamięci daemona, więc jedno
 * porównanie nie zgubi zmiany, o której moduł zapomniałby powiadomić.
 */

/** Tyle co cykl sesji (`TICK_MS` w `agents`), z którego przychodzą nowe rekordy hooków. */
const CHECK_MS = 200;

/** Zdarzenie bez numeru: to, co temat czyta z fasady. */
type TopicEvent = DaemonEvent extends infer E ? (E extends DaemonEvent ? Omit<E, "seq"> : never) : never;

interface Topic {
  /** Nazwa do logu daemona. */
  name: string;
  read: (facade: Facade) => TopicEvent;
}

/** Po jednym na typ zdarzenia z `DaemonEvent`; komplet sprawdza test gniazda zdarzeń. */
const TOPICS: readonly Topic[] = [
  { name: "sessions", read: (facade) => ({ type: "sessions.changed", payload: facade.agents.sessions() }) },
  { name: "mise running", read: (facade) => ({ type: "mise.running.changed", payload: facade.mise.running() }) },
];

export interface EventHubOptions {
  facade: Facade;
  log: (msg: string) => void;
}

export class EventHub {
  readonly #o: EventHubOptions;
  readonly #listeners = new Set<(event: DaemonEvent) => void>();
  /** Ostatnie zdarzenie i jego migawka jako JSON, po typie. */
  readonly #latest = new Map<DaemonEvent["type"], { event: DaemonEvent; json: string }>();
  /** Ostatni błąd odczytu tematu, żeby ten sam błąd co cykl nie zalewał logu. */
  readonly #failures = new Map<Topic, string>();
  #seq = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(o: EventHubOptions) {
    this.#o = o;
  }

  /** Słuchacz dostaje od razu migawkę każdego tematu, potem każdą zmianę; zwraca wypisanie. */
  subscribe(listener: (event: DaemonEvent) => void): () => void {
    this.#check();
    for (const { event } of this.#latest.values()) listener(event);
    this.#listeners.add(listener);
    this.#timer ??= setInterval(() => this.#check(), CHECK_MS);
    this.#timer.unref();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.close();
    };
  }

  /** Koniec porównywania; słuchacze, którzy zostali, nie dostaną już zdarzeń. */
  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #check(): void {
    for (const topic of TOPICS) {
      const next = this.#read(topic);
      if (!next) continue;
      const json = JSON.stringify(next.payload);
      if (this.#latest.get(next.type)?.json === json) continue;
      const event: DaemonEvent = { ...next, seq: ++this.#seq };
      this.#latest.set(next.type, { event, json });
      for (const listener of this.#listeners) listener(event);
    }
  }

  #read(topic: Topic): TopicEvent | undefined {
    try {
      const event = topic.read(this.#o.facade);
      this.#failures.delete(topic);
      return event;
    } catch (err) {
      const message = String(err);
      if (this.#failures.get(topic) !== message) this.#o.log(`reading ${topic.name} for events: ${message}`);
      this.#failures.set(topic, message);
      return undefined;
    }
  }
}
