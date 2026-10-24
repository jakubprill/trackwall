import type { DaemonEvent, DaemonEventOf, DaemonEventType } from "@trackwall/protocol";
import type { Facade } from "../facade.ts";

/**
 * Źródło zdarzeń `/ws` (§5.2, ADR-36): migawki tematów z fasady, porównywane co `CHECK_MS`, dopóki ktoś słucha.
 * Zmieniona migawka idzie do wszystkich słuchaczy jako zdarzenie, a nowy słuchacz dostaje najpierw najnowszą migawkę
 * każdego tematu. Porównanie zamiast powiadomień z modułów: stan sesji zmienia się w wielu miejscach (hooki, OSC,
 * klawisze, próg `Stale`, koniec grupy w `procs`), a migawka to odczyt z pamięci daemona, więc jedno porównanie nie
 * zgubi zmiany, o której moduł zapomniałby powiadomić.
 */

/** Tyle co cykl sesji (`TICK_MS` w `agents`), z którego przychodzą nowe rekordy hooków. */
const CHECK_MS = 200;

/** Odczyt migawki każdego tematu; brak tematu z `DaemonEvent` to błąd kompilacji. */
const TOPICS: { [T in DaemonEventType]: (facade: Facade) => DaemonEventOf<T> } = {
  "sessions.changed": (facade) => ({ type: "sessions.changed", payload: facade.agents.sessions() }),
  "mise.running.changed": (facade) => ({ type: "mise.running.changed", payload: facade.mise.running() }),
};

export interface EventListener {
  /** Zdarzenie jako gotowa ramka JSON, serializowana raz dla wszystkich słuchaczy. */
  event: (frame: string) => void;
  /**
   * Temat, którego migawkę słuchacz już dostał, przestał się dać odczytać: jego migawka jest nieaktualna, a nowej
   * nie będzie, więc słuchacz musi przestać ją uważać za stan na żywo.
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
  /** Ostatnia ramka i migawka jako JSON, po typie; temat, którego nie da się odczytać, tu nie jest. */
  readonly #latest = new Map<DaemonEventType, { frame: string; json: string }>();
  /** Ostatni błąd odczytu tematu, żeby ten sam błąd co cykl nie zalewał logu. */
  readonly #failures = new Map<DaemonEventType, string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(o: EventHubOptions) {
    this.#o = o;
  }

  /** Słuchacz dostaje od razu migawkę każdego tematu, potem każdą zmianę; zwraca wypisanie. */
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

  /** Koniec porównywania; słuchacze, którzy zostali, nie dostaną już zdarzeń. */
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
