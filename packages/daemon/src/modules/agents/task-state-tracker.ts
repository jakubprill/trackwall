import type { TaskStateChange, TaskStateSource } from "@trackwall/protocol";

/**
 * Łączy sygnały detektorów stanu jednej sesji zadania w jeden stan (§4.4). Zasady:
 *
 * - Najlepsze źródło, które się odezwało, wygrywa: po pierwszym hooku sekwencje terminala i ekran nie zmieniają
 *   już stanu, bo hook wie więcej. Dopóki hook milczy (np. nie działa na danym systemie), stan idzie ze słabszych.
 * - `Stale` tylko z `Working`: brak wyjścia i sygnałów dłużej niż próg. Czekanie na człowieka nie jest zawieszeniem.
 *   Każde wyjście po `Stale` wraca do stanu sprzed niego.
 * - Zakończenie procesu jest ostateczne; potem nic nie zmienia stanu.
 */

export type StateSignal = Omit<TaskStateChange, "at">;

/** Źródła, z których przychodzą sygnały detektorów; `timeout` i `exit` ustala sam tracker. */
type DetectorSource = Exclude<TaskStateSource, "timeout" | "exit">;

const DETECTOR_RANK: Record<DetectorSource, number> = { screen: 1, osc: 2, hook: 3 };

function isDetectorSource(source: TaskStateSource): source is DetectorSource {
  return source in DETECTOR_RANK;
}

export interface TaskStateTrackerOptions {
  now: () => number;
  /** Po tylu milisekundach bez wyjścia i sygnałów `Working` przechodzi w `Stale`. */
  staleAfterMs: number;
}

export class TaskStateTracker {
  readonly #now: () => number;
  readonly #staleAfterMs: number;
  #current: TaskStateChange | undefined;
  #beforeStale: TaskStateChange | undefined;
  #bestRank = 0;
  #lastActivity: number;
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
  signal(s: StateSignal): TaskStateChange | undefined {
    if (this.#exited || !isDetectorSource(s.source)) return undefined;
    const rank = DETECTOR_RANK[s.source];
    if (rank < this.#bestRank) return undefined;
    this.#bestRank = rank;
    this.#lastActivity = this.#now();
    return this.#set(s);
  }

  /** Sesja coś wypisała. */
  activity(): TaskStateChange | undefined {
    this.#lastActivity = this.#now();
    if (this.#exited || this.#current?.state !== "Stale" || !this.#beforeStale) return undefined;
    const { at: _, ...previous } = this.#beforeStale;
    return this.#set(previous);
  }

  /** Wywoływane cyklicznie; zwraca zmianę na `Stale`, gdy minął próg. */
  tick(): TaskStateChange | undefined {
    if (this.#exited || this.#current?.state !== "Working") return undefined;
    const silentMs = this.#now() - this.#lastActivity;
    if (silentMs < this.#staleAfterMs) return undefined;
    this.#beforeStale = this.#current;
    return this.#set({
      state: "Stale",
      source: "timeout",
      confidence: "medium",
      reason: `brak wyjścia od ${Math.round(silentMs / 1000)} s`,
    });
  }

  /** Proces sesji się zakończył. Stan `Done` albo `Error` z hooka zostaje, bo mówi więcej niż kod wyjścia. */
  exit(code: number): TaskStateChange | undefined {
    if (this.#exited) return undefined;
    this.#exited = true;
    const current = this.#current;
    if (current?.source === "hook" && (current.state === "Done" || current.state === "Error")) return undefined;
    const state = code === 0 ? "Done" : "Error";
    return this.#set({ state, source: "exit", confidence: "exact", reason: `kod wyjścia ${code}` });
  }

  #set(s: StateSignal): TaskStateChange | undefined {
    const c = this.#current;
    if (c && c.state === s.state && c.source === s.source && c.confidence === s.confidence) return undefined;
    this.#current = { ...s, at: new Date(this.#now()).toISOString() };
    return this.#current;
  }
}
