import type { TaskStateChange, TaskStateSource } from "@trackwall/protocol";

/**
 * Łączy sygnały detektorów stanu jednej sesji zadania w jeden stan (§4.4). Zasady:
 *
 * - Najlepsze źródło, które się odezwało, wygrywa: po pierwszym hooku sekwencje terminala i ekran nie zmieniają
 *   już stanu, bo hook wie więcej. Dopóki hook milczy (np. nie działa na danym systemie), stan idzie ze słabszych.
 *   Wyjątek: słabsze źródło może zakończyć `Working`. Gdy hook końca tury nie przyjdzie (zgubiony, przekroczony
 *   czas hooka, przerwana tura), sesja nie wisi w `Working`, a potem w `Stale`, choć czeka na człowieka.
 * - Klawisz człowieka (`keyboard`) przechodzi zawsze, bo mówi o tym, czego hooki nie zgłaszają: odpowiedzi na prośbę
 *   o zgodę i przerwaniu tury. Detektor klawiszy sam wybiera, w jakim stanie klawisz coś znaczy (`copilot-keys.ts`).
 * - `Stale` tylko z `Working`: brak wyjścia i sygnałów przez próg. Czekanie na człowieka nie jest zawieszeniem.
 *   Czas i powód `Stale` zależą tylko od ostatniej aktywności i progu, nie od tego, jak często woła się `tick`,
 *   więc na żywo i przy odtwarzaniu nagrania wychodzi to samo. Każde wyjście po `Stale` wraca do stanu sprzed niego.
 * - Zakończenie procesu jest ostateczne; potem nic nie zmienia stanu. Kod wyjścia rozstrzyga `Done` albo `Error`,
 *   chyba że detektor zgłosił już koniec sesji (`endsSession`), bo mówi więcej niż kod.
 */

const DETECTOR_RANK = { screen: 1, osc: 2, hook: 3 } as const satisfies Partial<Record<TaskStateSource, number>>;

/** Źródła sygnałów detektorów obserwujących sesję; `keyboard`, `timeout` i `exit` mają własne metody. */
type DetectorSource = keyof typeof DETECTOR_RANK;

export type StateSignal = Omit<TaskStateChange, "at" | "source"> & {
  source: DetectorSource;
  /** Sygnał końca sesji (np. hook `sessionEnd`); kod wyjścia procesu go już nie zmienia. */
  endsSession?: true;
};

/** Klawisz człowieka w terminalu sesji (`copilot-keys.ts`). */
export type KeyboardSignal = Omit<TaskStateChange, "at" | "source"> & { source: "keyboard" };

type TrackedState = Omit<TaskStateChange, "at">;

export interface TaskStateTrackerOptions {
  now: () => number;
  /** Po tylu milisekundach bez wyjścia i sygnałów `Working` przechodzi w `Stale`. */
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

  /** Sygnał detektora; zwraca zmianę, gdy stan, źródło albo pewność są inne niż dotąd. */
  signal({ endsSession, ...s }: StateSignal): TaskStateChange | undefined {
    const rank = DETECTOR_RANK[s.source];
    const endsWork = this.#current?.state === "Working" && s.state !== "Working";
    if (this.#exited || (rank < this.#bestRank && !endsWork)) return undefined;
    this.#bestRank = Math.max(this.#bestRank, rank);
    this.#sessionEnded ||= endsSession === true;
    this.#lastActivity = this.#now();
    return this.#set(s, this.#lastActivity);
  }

  /** Klawisz człowieka: bez rangi źródeł, bo mówi o tym, czego hooki nie zgłaszają. */
  keyboard(s: KeyboardSignal): TaskStateChange | undefined {
    if (this.#exited) return undefined;
    this.#lastActivity = this.#now();
    return this.#set(s, this.#lastActivity);
  }

  /** Sesja coś wypisała. */
  activity(): TaskStateChange | undefined {
    this.#lastActivity = this.#now();
    if (this.#exited || this.#current?.state !== "Stale" || !this.#beforeStale) return undefined;
    return this.#set(this.#beforeStale, this.#lastActivity);
  }

  /** Wywoływane cyklicznie; zwraca zmianę na `Stale`, gdy minął próg. */
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

  /** Proces sesji się zakończył. */
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
