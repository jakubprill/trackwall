import { describe, expect, test } from "bun:test";
import { oncePerFrame } from "../src/lib/once-per-frame.ts";

describe("jedno wywołanie na klatkę", () => {
  test("seria próśb przed następną klatką daje jedno wywołanie, a kolejna klatka następne", () => {
    const frames: (() => void)[] = [];
    let calls = 0;
    const fit = oncePerFrame(
      () => calls++,
      (frame) => frames.push(frame),
      () => {},
    );

    fit.request();
    fit.request();
    fit.request();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(calls).toBe(1);

    fit.request();
    frames.shift()?.();
    expect(calls).toBe(2);
  });

  test("zamknięcie odwołuje zaplanowane wywołanie", () => {
    const cancelled: number[] = [];
    const fit = oncePerFrame(
      () => {
        throw new Error("wywołanie po zamknięciu");
      },
      () => 9,
      (handle) => cancelled.push(handle),
    );

    fit.request();
    fit.dispose();
    expect(cancelled).toEqual([9]);
  });
});
