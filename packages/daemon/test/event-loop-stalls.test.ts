import { describe, expect, test } from "bun:test";
import { stallNote, watchEventLoopStalls } from "../src/infra/event-loop-stalls.ts";

describe("the log line of an event loop that stood still", () => {
  test("a check that came 500 ms or more late says how long the loop stood still", () => {
    expect(stallNote(1_234.4)).toBe("the event loop stood still for at least 1234 ms");
  });

  test("a check less than 500 ms late gets no line", () => {
    expect(stallNote(499)).toBeUndefined();
  });

  test("code that holds the loop for a second gets a line about it", async () => {
    const lines: string[] = [];
    const stop = watchEventLoopStalls((line) => lines.push(line));
    const until = performance.now() + 1_000;
    while (performance.now() < until) {
      // holds the event loop, as a process start an antivirus scans does
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    stop();
    // The check due 250 ms after the start comes about 750 ms late; a slow machine may stall the loop again meanwhile,
    // so the line is looked for, not counted.
    const stalls = lines.map((line) => Number(/^the event loop stood still for at least (\d+) ms$/.exec(line)?.[1]));
    expect(stalls.some((ms) => ms >= 700)).toBe(true);
  });
});
