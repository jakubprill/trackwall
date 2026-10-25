import { describe, expect, test } from "bun:test";
import { oncePerFrame } from "../src/lib/once-per-frame.ts";

describe("one call per frame", () => {
  test("a series of requests before the next frame gives one call, and the next frame another", () => {
    const frames: (() => void)[] = [];
    let calls = 0;
    const perFrame = oncePerFrame(
      () => calls++,
      (frame) => frames.push(frame),
      () => {},
    );

    perFrame.request();
    perFrame.request();
    perFrame.request();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(calls).toBe(1);

    perFrame.request();
    frames.shift()?.();
    expect(calls).toBe(2);
  });

  test("closing cancels the scheduled call", () => {
    const cancelled: number[] = [];
    const perFrame = oncePerFrame(
      () => {
        throw new Error("call after closing");
      },
      () => 9,
      (handle) => cancelled.push(handle),
    );

    perFrame.request();
    perFrame.dispose();
    expect(cancelled).toEqual([9]);
  });
});
