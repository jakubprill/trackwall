/** Timers a class takes from outside, so that its tests run them by hand. */
export interface Timers<Timer> {
  set(run: () => void, ms: number): Timer;
  clear(timer: Timer): void;
}

/** The browser's own timers, for the views that create such a class. */
export const browserTimers: Timers<ReturnType<typeof setTimeout>> = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
};
