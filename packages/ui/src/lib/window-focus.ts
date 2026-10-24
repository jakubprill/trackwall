/**
 * Whether the session terminal window is in front of the user, as the daemon needs it to mark a session seen
 * (ADR-47). "In front" is a focused and visible document, and it counts only after `SEEN_AFTER_MS`: a click on a
 * tray entry first brings the window to the front with the previous session's terminal and only then switches to
 * the chosen session, and a window the user only flicks past has not been looked at either.
 */

export const SEEN_AFTER_MS = 1000;

export function windowInFront(doc: Pick<Document, "hasFocus" | "visibilityState">): boolean {
  return doc.hasFocus() && doc.visibilityState === "visible";
}

export interface FocusTimers {
  set(run: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

export class FocusReporter {
  readonly #send: (focused: boolean) => void;
  readonly #inFront: () => boolean;
  readonly #timers: FocusTimers;
  #timer: unknown;
  #reported = false;

  constructor(send: (focused: boolean) => void, inFront: () => boolean, timers: FocusTimers) {
    this.#send = send;
    this.#inFront = inFront;
    this.#timers = timers;
  }

  /** The window gained or lost focus or visibility. */
  update(): void {
    if (this.#inFront()) {
      if (this.#reported || this.#timer !== undefined) return;
      this.#timer = this.#timers.set(() => {
        this.#timer = undefined;
        this.#reported = true;
        this.#send(true);
      }, SEEN_AFTER_MS);
      return;
    }
    this.#cancel();
    if (this.#reported) this.#send(false);
    this.#reported = false;
  }

  /** A new connection to the daemon knows nothing of this window yet, so it starts as not in front. */
  connected(): void {
    this.#cancel();
    this.#reported = false;
    this.update();
  }

  dispose(): void {
    this.#cancel();
  }

  #cancel(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }
}
