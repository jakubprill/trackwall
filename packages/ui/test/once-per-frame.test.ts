import { describe, expect, test } from "bun:test";
import { oncePerFrame } from "../src/lib/once-per-frame.ts";

describe("jedno wywołanie na klatkę", () => {
  test("seria próśb przed następną klatką daje jedno wywołanie, a kolejna klatka następne", () => {
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

  test("zamknięcie odwołuje zaplanowane wywołanie", () => {
    const cancelled: number[] = [];
    const perFrame = oncePerFrame(
      () => {
        throw new Error("wywołanie po zamknięciu");
      },
      () => 9,
      (handle) => cancelled.push(handle),
    );

    perFrame.request();
    perFrame.dispose();
    expect(cancelled).toEqual([9]);
  });
});
