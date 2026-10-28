import { describe, expect, test } from "bun:test";
import { PacedFrames } from "../src/lib/paced-frames.ts";

/** A 60 Hz display: `frames(n)` runs the next `n` display frames, 1000/60 ms apart. */
function display() {
  let now = 0;
  let pending: ((timeMs: number) => void) | undefined;
  const scheduler = {
    request: (frame: (timeMs: number) => void) => {
      pending = frame;
      return 1;
    },
    cancel: () => {
      pending = undefined;
    },
    now: () => now,
  };
  return {
    scheduler,
    frames(n: number) {
      for (let i = 0; i < n; i++) {
        now += 1000 / 60;
        pending?.(now);
      }
    },
  };
}

describe("the pace of the dashboard scene", () => {
  test("at rest the scene draws 10 frames a second on a 60 Hz display", () => {
    const screen = display();
    const frames = new PacedFrames(screen.scheduler);
    const ticks: number[] = [];
    frames.start((t) => ticks.push(t));

    screen.frames(60);

    expect(ticks).toHaveLength(10);
  });

  test("after a wake it draws every frame for two seconds, then goes back to rest", () => {
    const screen = display();
    const frames = new PacedFrames(screen.scheduler);
    const ticks: number[] = [];
    frames.start((t) => ticks.push(t));

    frames.wake();
    screen.frames(110);
    expect(ticks).toHaveLength(110);

    screen.frames(10);
    ticks.length = 0;
    screen.frames(60);
    expect(ticks).toHaveLength(10);
  });

  test("another wake keeps every frame for two seconds after it, as a drag goes on", () => {
    const screen = display();
    const frames = new PacedFrames(screen.scheduler);
    const ticks: number[] = [];
    frames.start((t) => ticks.push(t));

    frames.wake();
    screen.frames(90);
    frames.wake();
    screen.frames(110);

    expect(ticks).toHaveLength(200);
  });

  test("a scene started again after a stop draws again", () => {
    const screen = display();
    const frames = new PacedFrames(screen.scheduler);
    const ticks: number[] = [];
    frames.start((t) => ticks.push(t));
    frames.stop();

    frames.start((t) => ticks.push(t));
    screen.frames(60);

    expect(ticks).toHaveLength(10);
  });

  test("a stopped scene draws nothing", () => {
    const screen = display();
    const frames = new PacedFrames(screen.scheduler);
    const ticks: number[] = [];
    frames.start((t) => ticks.push(t));
    frames.wake();

    frames.stop();
    screen.frames(60);

    expect(ticks).toEqual([]);
  });
});
