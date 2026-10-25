import { describe, expect, test } from "bun:test";
import { activeHides } from "../src/lib/task-hides.ts";

describe("hiding ended tasks", () => {
  test("two tasks ended before the next list stay hidden until a list sent after each arrives", () => {
    const hides = [
      { task: "t1", afterLoad: 3 },
      { task: "t2", afterLoad: 4 },
    ];
    expect(activeHides(hides, 3).map((h) => h.task)).toEqual(["t1", "t2"]);
    expect(activeHides(hides, 4).map((h) => h.task)).toEqual(["t2"]);
    expect(activeHides(hides, 5)).toEqual([]);
  });

  test("before any list has loaded every hide is active", () => {
    expect(activeHides([{ task: "t1", afterLoad: 0 }], undefined).map((h) => h.task)).toEqual(["t1"]);
  });
});
