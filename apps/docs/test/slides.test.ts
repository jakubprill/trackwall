import { expect, test } from "bun:test";
import { slideToShow } from "../.vitepress/theme/slides.ts";

// Three slides starting at 100, 900 and 1700 pixels down the page.
const tops = [100, 900, 1700];

test("the next key goes from the shown slide to the one after it", () => {
  expect(slideToShow(tops, 900, 1)).toBe(2);
});

test("the previous key goes from the shown slide to the one before it", () => {
  expect(slideToShow(tops, 900, -1)).toBe(0);
});

test("a slide a few pixels below the top of the window counts as shown", () => {
  expect(slideToShow(tops, 895, 1)).toBe(2);
});

test("from the middle of a slide the next key goes to the one below and the previous key to its own start", () => {
  expect({ next: slideToShow(tops, 1200, 1), previous: slideToShow(tops, 1200, -1) }).toEqual({ next: 2, previous: 1 });
});

test("above the first slide the next key goes to the first and the previous key does nothing", () => {
  expect({ next: slideToShow(tops, 0, 1), previous: slideToShow(tops, 0, -1) }).toEqual({ next: 0, previous: undefined });
});

test("the last slide stays the last and the first stays the first", () => {
  expect({ last: slideToShow(tops, 1700, 1), first: slideToShow(tops, 100, -1) }).toEqual({ last: 2, first: 0 });
});

test("a page without slides has nowhere to go", () => {
  expect(slideToShow([], 0, 1)).toBeUndefined();
});
