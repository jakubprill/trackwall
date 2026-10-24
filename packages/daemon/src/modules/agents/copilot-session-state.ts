import type { TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import { stateFromHook } from "./copilot-hooks.ts";
import { type SessionKey, stateFromKey } from "./copilot-keys.ts";
import { stateFromOsc, windowTitleFromOsc } from "./copilot-osc.ts";
import { CopilotScreen } from "./copilot-screen.ts";
import { OscParser } from "./osc-parser.ts";
import { TaskStateTracker, type TaskStateTrackerOptions } from "./task-state-tracker.ts";

/**
 * Stan jednej sesji Copilot CLI (§4.4): wyjście PTY, rekordy hooków i klawisze człowieka wchodzą, zmiany stanu
 * wychodzą.
 * Ten sam obiekt liczy stan na żywo i przy odtwarzaniu nagrania, więc test na nagraniu sprawdza to, co działa
 * w sesji.
 */
/**
 * Przerwanie tury zawsze idzie po klawiszu człowieka (Esc, Ctrl+C, Enter na odmowie), a ten sam komunikat może wrócić
 * na ekran przy przerysowaniu historii, np. po zmianie rozmiaru. Dlatego liczy się tylko tuż po klawiszu sesji.
 */
const CANCEL_AFTER_KEY_MS = 10_000;

export class CopilotSessionState {
  readonly #osc = new OscParser();
  readonly #screen = new CopilotScreen();
  readonly #tracker: TaskStateTracker;
  readonly #now: () => number;
  #windowTitle: string | undefined;
  /** Czas ostatniego klawisza sesji; starszy hook, odczytany dopiero po nim, nie zmienia już stanu. */
  #lastKeyAt = Number.NEGATIVE_INFINITY;

  constructor(o: TaskStateTrackerOptions) {
    this.#tracker = new TaskStateTracker(o);
    this.#now = o.now;
  }

  /** Ostatni tytuł okna ustawiony przez Copilot CLI: nad czym agent pracuje. */
  get windowTitle(): string | undefined {
    return this.#windowTitle;
  }

  /**
   * Każde wejście i koniec procesu najpierw sprawdza próg `Stale`. Odtwarzanie nie ma cyklicznego `tick`,
   * więc dzięki temu daje tę samą kolejność zmian co sesja na żywo.
   */
  output(data: string): TaskStateChange[] {
    const changes = [this.#tracker.tick(), this.#tracker.activity()];
    for (const osc of this.#osc.feed(data)) {
      this.#windowTitle = windowTitleFromOsc(osc) ?? this.#windowTitle;
      const signal = stateFromOsc(osc);
      if (signal) changes.push(this.#tracker.signal(signal));
    }
    const cancelled = this.#screen.feed(data);
    if (cancelled && this.#now() - this.#lastKeyAt <= CANCEL_AFTER_KEY_MS) changes.push(this.#tracker.signal(cancelled));
    return changes.filter((c) => c !== undefined);
  }

  /**
   * Rekord hooka sprzed ostatniego klawisza sesji mówi o stanie, na który człowiek już odpowiedział (np. prośba
   * o zgodę odczytana z `hooks.jsonl` dopiero po Enter), więc nie zmienia stanu.
   */
  hook(record: CopilotHookRecord): TaskStateChange[] {
    const signal = record.receivedAt < this.#lastKeyAt ? undefined : stateFromHook(record);
    return [this.#tracker.tick(), signal && this.#tracker.signal(signal)].filter((c) => c !== undefined);
  }

  /** Klawisz, który człowiek wysłał do terminala sesji (`sessionKey`). */
  key(key: SessionKey): TaskStateChange[] {
    // Najpierw próg `Stale`: na żywo cykliczny `tick` mógł go już ustawić, a klawisz liczy się ze stanu po nim.
    const stale = this.#tracker.tick();
    this.#lastKeyAt = this.#now();
    const signal = stateFromKey(key, this.#tracker.current?.state);
    return [stale, signal && this.#tracker.keyboard(signal)].filter((c) => c !== undefined);
  }

  tick(): TaskStateChange | undefined {
    return this.#tracker.tick();
  }

  exit(code: number): TaskStateChange[] {
    return [this.#tracker.tick(), this.#tracker.exit(code)].filter((c) => c !== undefined);
  }
}
