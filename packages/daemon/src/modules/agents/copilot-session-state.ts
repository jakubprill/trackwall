import type { TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import { stateFromHook } from "./copilot-hooks.ts";
import { stateFromOsc, windowTitleFromOsc } from "./copilot-osc.ts";
import { OscParser } from "./osc-parser.ts";
import { TaskStateTracker, type TaskStateTrackerOptions } from "./task-state-tracker.ts";

/**
 * Stan jednej sesji Copilot CLI (§4.4): wyjście PTY i rekordy hooków wchodzą, zmiany stanu wychodzą.
 * Ten sam obiekt liczy stan na żywo i przy odtwarzaniu nagrania, więc test na nagraniu sprawdza to, co działa
 * w sesji.
 */
export class CopilotSessionState {
  readonly #osc = new OscParser();
  readonly #tracker: TaskStateTracker;
  #windowTitle: string | undefined;

  constructor(o: TaskStateTrackerOptions) {
    this.#tracker = new TaskStateTracker(o);
  }

  /** Ostatni tytuł okna ustawiony przez Copilot CLI: nad czym agent pracuje. */
  get windowTitle(): string | undefined {
    return this.#windowTitle;
  }

  /**
   * Każde wejście najpierw sprawdza próg `Stale`. Odtwarzanie nie ma cyklicznego `tick`, więc dzięki temu daje tę
   * samą kolejność zmian co sesja na żywo.
   */
  output(data: string): TaskStateChange[] {
    const changes = [this.#tracker.tick(), this.#tracker.activity()];
    for (const osc of this.#osc.feed(data)) {
      this.#windowTitle = windowTitleFromOsc(osc) ?? this.#windowTitle;
      const signal = stateFromOsc(osc);
      if (signal) changes.push(this.#tracker.signal(signal));
    }
    return changes.filter((c) => c !== undefined);
  }

  hook(record: CopilotHookRecord): TaskStateChange[] {
    const signal = stateFromHook(record);
    return [this.#tracker.tick(), signal && this.#tracker.signal(signal)].filter((c) => c !== undefined);
  }

  tick(): TaskStateChange | undefined {
    return this.#tracker.tick();
  }

  exit(code: number): TaskStateChange | undefined {
    return this.#tracker.exit(code);
  }
}
