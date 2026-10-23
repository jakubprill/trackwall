import type { TaskStateChange } from "@trackwall/protocol";
import { type CopilotHookRecord, stateFromHook } from "./copilot-hooks.ts";
import { intentFromOsc, stateFromOsc } from "./copilot-osc.ts";
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
  #intent: string | undefined;

  constructor(o: TaskStateTrackerOptions) {
    this.#tracker = new TaskStateTracker(o);
  }

  get current(): TaskStateChange | undefined {
    return this.#tracker.current;
  }

  /** Ostatni tytuł okna ustawiony przez Copilot CLI: nad czym agent pracuje. */
  get intent(): string | undefined {
    return this.#intent;
  }

  output(data: string): TaskStateChange[] {
    const changes = [this.#tracker.activity()];
    for (const osc of this.#osc.feed(data)) {
      this.#intent = intentFromOsc(osc) ?? this.#intent;
      const signal = stateFromOsc(osc);
      if (signal) changes.push(this.#tracker.signal(signal));
    }
    return changes.filter((c) => c !== undefined);
  }

  hook(record: CopilotHookRecord): TaskStateChange | undefined {
    const signal = stateFromHook(record);
    return signal && this.#tracker.signal(signal);
  }

  tick(): TaskStateChange | undefined {
    return this.#tracker.tick();
  }

  exit(code: number): TaskStateChange | undefined {
    return this.#tracker.exit(code);
  }
}
