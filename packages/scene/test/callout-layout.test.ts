import { expect, test } from "bun:test";
import { CALLOUT_BASE_RISE, layoutCallouts } from "../src/callout-layout.ts";

const label = { width: 100, height: 30, side: null };
const canvas = { left: 0, right: 1000 };

test("a callout stands on the side of its object away from the middle of the ring", () => {
  const placed = layoutCallouts(
    [
      { key: "left", anchor: { x: 200, y: 300 }, ...label },
      { key: "right", anchor: { x: 700, y: 300 }, ...label },
    ],
    450,
    canvas,
  );

  expect(placed.get("left")).toEqual({ side: "left", rise: CALLOUT_BASE_RISE });
  expect(placed.get("right")).toEqual({ side: "right", rise: CALLOUT_BASE_RISE });
});

test("callouts that would cover each other stack, the one nearer the bottom of the screen keeps its place", () => {
  const placed = layoutCallouts(
    [
      { key: "behind", anchor: { x: 600, y: 290 }, ...label },
      { key: "front", anchor: { x: 610, y: 300 }, ...label },
    ],
    450,
    canvas,
  );

  expect(placed.get("front")?.rise).toBe(CALLOUT_BASE_RISE);
  // The front callout's top is at 300 − 22 − 15 = 263; the one behind ends 4 px above it, its middle 15 px higher still.
  expect(placed.get("behind")?.rise).toBe(290 - (263 - 4 - 15));
});

test("callouts far apart on the screen do not move each other", () => {
  const placed = layoutCallouts(
    [
      { key: "a", anchor: { x: 600, y: 290 }, ...label },
      { key: "b", anchor: { x: 900, y: 300 }, ...label },
    ],
    450,
    canvas,
  );

  expect(placed.get("a")?.rise).toBe(CALLOUT_BASE_RISE);
  expect(placed.get("b")?.rise).toBe(CALLOUT_BASE_RISE);
});

test("an object close to the middle keeps the side its callout already had, so turning the camera a little does not flip it", () => {
  const placed = layoutCallouts([{ key: "front", anchor: { x: 445, y: 500 }, ...label, side: "right" }], 450, canvas);

  expect(placed.get("front")?.side).toBe("right");
});

test("a callout that would stick out of the canvas on its side goes to the other side", () => {
  const placed = layoutCallouts([{ key: "edge", anchor: { x: 60, y: 300 }, ...label }], 450, canvas);

  expect(placed.get("edge")?.side).toBe("right");
});
