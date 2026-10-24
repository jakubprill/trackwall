import { describe, expect, test } from "bun:test";
import { type TerminalSize, terminalResizer } from "../src/lib/terminal-resizer.ts";

describe("dopasowanie terminala sesji do okna", () => {
  test("seria zmian rozmiaru w jednej klatce daje jedno dopasowanie, a ten sam rozmiar nie trafia drugi raz do sesji", () => {
    const frames: (() => void)[] = [];
    let fits: TerminalSize = { cols: 120, rows: 40 };
    const applied: TerminalSize[] = [];
    const resizer = terminalResizer({
      initial: { cols: 80, rows: 24 },
      measure: () => fits,
      apply: (size) => applied.push(size),
      schedule: (callback) => frames.push(callback),
      cancel: () => {},
    });

    resizer.request();
    resizer.request();
    resizer.request();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(applied).toEqual([{ cols: 120, rows: 40 }]);

    // Pasek przewijania pojawił się i zniknął, a rozmiar w znakach się nie zmienił.
    resizer.request();
    frames.shift()?.();
    expect(applied).toEqual([{ cols: 120, rows: 40 }]);

    fits = { cols: 100, rows: 40 };
    resizer.request();
    frames.shift()?.();
    expect(applied).toEqual([
      { cols: 120, rows: 40 },
      { cols: 100, rows: 40 },
    ]);
  });

  test("kontener bez wymiarów (schowana zakładka) nie zmienia rozmiaru, a zamknięcie odwołuje zaplanowane dopasowanie", () => {
    const cancelled: number[] = [];
    const applied: TerminalSize[] = [];
    const resizer = terminalResizer({
      initial: { cols: 80, rows: 24 },
      measure: () => undefined,
      apply: (size) => applied.push(size),
      schedule: (callback) => {
        callback();
        return 7;
      },
      cancel: (handle) => cancelled.push(handle),
    });

    resizer.request();
    expect(applied).toEqual([]);

    const later = terminalResizer({
      initial: { cols: 80, rows: 24 },
      measure: () => ({ cols: 1, rows: 1 }),
      apply: (size) => applied.push(size),
      schedule: () => 9,
      cancel: (handle) => cancelled.push(handle),
    });
    later.request();
    later.dispose();
    expect(cancelled).toEqual([9]);
  });
});
