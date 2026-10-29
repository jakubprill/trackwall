import { describe, expect, test } from "bun:test";
import type { Timers } from "../src/lib/timers.ts";
import { FocusReporter, SEEN_AFTER_MS, terminalInFront, windowInFront } from "../src/lib/window-focus.ts";

/** Timers run by hand: `elapse` runs the timers that would have fired. */
function manualTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  const timers: Timers<number> = {
    set: (run, ms) => {
      next++;
      pending.set(next, { at: now + ms, run });
      return next;
    },
    clear: (timer) => pending.delete(timer),
  };
  const elapse = (ms: number) => {
    now += ms;
    for (const [id, t] of [...pending]) {
      if (t.at > now) continue;
      pending.delete(id);
      t.run();
    }
  };
  return { timers, elapse };
}

describe("session terminal in front of the user (ADR-47)", () => {
  test("only a focused and visible document is in front of the user", () => {
    expect(windowInFront({ hasFocus: () => true, visibilityState: "visible" })).toBe(true);
    expect(windowInFront({ hasFocus: () => false, visibilityState: "visible" })).toBe(false);
    expect(windowInFront({ hasFocus: () => true, visibilityState: "hidden" })).toBe(false);
  });

  test("the window reports being in front only after it has stayed there for a moment", () => {
    const { timers, elapse } = manualTimers();
    const sent: boolean[] = [];
    const reporter = new FocusReporter(
      (f) => sent.push(f),
      () => true,
      timers,
    );

    reporter.connected();
    elapse(SEEN_AFTER_MS - 1);
    expect(sent).toEqual([]);
    elapse(1);

    expect(sent).toEqual([true]);
  });

  test("a window that leaves the front before the moment passes reports nothing", () => {
    const { timers, elapse } = manualTimers();
    const sent: boolean[] = [];
    let inFront = true;
    const reporter = new FocusReporter(
      (f) => sent.push(f),
      () => inFront,
      timers,
    );
    reporter.connected();

    elapse(300);
    inFront = false;
    reporter.update();
    elapse(SEEN_AFTER_MS);

    expect(sent).toEqual([]);
  });

  test("a terminal that closes before the moment passes reports nothing, as when a tray click switches sessions", () => {
    const { timers, elapse } = manualTimers();
    const sent: boolean[] = [];
    const reporter = new FocusReporter(
      (f) => sent.push(f),
      () => true,
      timers,
    );
    reporter.connected();

    elapse(300);
    reporter.dispose();
    elapse(SEEN_AFTER_MS);

    expect(sent).toEqual([]);
  });

  test("a window that reported being in front reports leaving it", () => {
    const { timers, elapse } = manualTimers();
    const sent: boolean[] = [];
    let inFront = true;
    const reporter = new FocusReporter(
      (f) => sent.push(f),
      () => inFront,
      timers,
    );
    reporter.connected();
    elapse(SEEN_AFTER_MS);

    inFront = false;
    reporter.update();

    expect(sent).toEqual([true, false]);
  });

  test("a new connection reports the window again", () => {
    const { timers, elapse } = manualTimers();
    const sent: boolean[] = [];
    const reporter = new FocusReporter(
      (f) => sent.push(f),
      () => true,
      timers,
    );
    reporter.connected();
    elapse(SEEN_AFTER_MS);

    reporter.connected();
    elapse(SEEN_AFTER_MS);

    expect(sent).toEqual([true, true]);
  });
});

describe("terminal in the session grid", () => {
  test("only the selected tile counts as in front, so a waiting session in another tile is not marked seen", () => {
    const front = { hasFocus: () => true, visibilityState: "visible" } as const;
    expect(terminalInFront(true, front)).toBe(true);
    expect(terminalInFront(false, front)).toBe(false);
    expect(terminalInFront(true, { hasFocus: () => false, visibilityState: "visible" })).toBe(false);
  });
});
