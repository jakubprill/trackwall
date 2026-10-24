import type { TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import { stateFromHook } from "./copilot-hooks.ts";
import { type SessionKey, stateFromKey } from "./copilot-keys.ts";
import { stateFromOsc, windowTitleFromOsc } from "./copilot-osc.ts";
import { CopilotScreen } from "./copilot-screen.ts";
import { OscParser } from "./osc-parser.ts";
import { type StateSignal, TaskStateTracker, type TaskStateTrackerOptions } from "./task-state-tracker.ts";

/** `sessionStart` sesji, która startuje z poleceniem (`promptOnStart`). */
const SESSION_START_WITH_PROMPT: StateSignal = {
  state: "Working",
  source: "hook",
  confidence: "medium",
  reason: "hook sessionStart with a prompt",
};

/**
 * Komunikat o przerwanej turze liczy się tylko tyle po odpowiedzi klawiszem: ten sam tekst wraca na ekran przy
 * przerysowaniu historii, np. po zmianie rozmiaru.
 */
const CANCEL_AFTER_ANSWER_MS = 10_000;

/**
 * Stan jednej sesji Copilot CLI (§4.4): wyjście PTY, rekordy hooków i klawisze człowieka wchodzą, zmiany stanu
 * wychodzą. Ten sam obiekt liczy stan na żywo i przy odtwarzaniu nagrania, więc test na nagraniu sprawdza to,
 * co działa w sesji.
 */
export interface CopilotSessionStateOptions extends TaskStateTrackerOptions {
  /**
   * Sesja startuje z poleceniem jako pierwszą wiadomością (`--interactive`, sesja nowego zadania, ADR-31), więc
   * `sessionStart` znaczy początek pracy nad poleceniem, a nie czekanie na Ciebie. Bez tego sesja zadania przez chwilę
   * między `sessionStart` a `userPromptSubmitted` czekałaby na Ciebie, a `wait_for_session` (ADR-39) kończyłby
   * czekanie, zanim agent zacznie.
   */
  promptOnStart: boolean;
}

export class CopilotSessionState {
  readonly #osc = new OscParser();
  readonly #screen = new CopilotScreen();
  readonly #tracker: TaskStateTracker;
  readonly #now: () => number;
  /** Pierwszy `sessionStart` jeszcze nie przyszedł; tylko on niesie polecenie, a `/clear` albo `/resume` w sesji już nie. */
  #promptPending: boolean;
  #windowTitle: string | undefined;
  /** Czas ostatniego klawisza sesji, który zmienił stan (odpowiedź na prośbę albo przerwanie). */
  #lastAnswerAt = Number.NEGATIVE_INFINITY;

  constructor(o: CopilotSessionStateOptions) {
    this.#tracker = new TaskStateTracker(o);
    this.#now = o.now;
    this.#promptPending = o.promptOnStart;
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
    if (cancelled && this.#now() - this.#lastAnswerAt <= CANCEL_AFTER_ANSWER_MS) changes.push(this.#tracker.signal(cancelled));
    return changes.filter((c) => c !== undefined);
  }

  hook(record: CopilotHookRecord): TaskStateChange[] {
    const withPrompt = this.#promptPending && record.event === "sessionStart";
    if (record.event === "sessionStart") this.#promptPending = false;
    const signal = withPrompt ? SESSION_START_WITH_PROMPT : stateFromHook(record);
    return [this.#tracker.tick(), signal && this.#tracker.signal(signal)].filter((c) => c !== undefined);
  }

  /** Klawisz, który człowiek wysłał do terminala sesji (`sessionKey`). */
  key(key: SessionKey): TaskStateChange[] {
    // Najpierw próg `Stale`: na żywo cykliczny `tick` mógł go już ustawić, a klawisz liczy się ze stanu po nim.
    const stale = this.#tracker.tick();
    const signal = stateFromKey(key, this.#tracker.current?.state);
    if (!signal) return [stale].filter((c) => c !== undefined);
    this.#lastAnswerAt = this.#now();
    return [stale, this.#tracker.keyboard(signal)].filter((c) => c !== undefined);
  }

  tick(): TaskStateChange | undefined {
    return this.#tracker.tick();
  }

  exit(code: number): TaskStateChange[] {
    return [this.#tracker.tick(), this.#tracker.exit(code)].filter((c) => c !== undefined);
  }
}
