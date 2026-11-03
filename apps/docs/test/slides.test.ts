import { expect, test } from "bun:test";
import { hashOfSlide, slideFromHash, stepSlide } from "../.vitepress/theme/slides.ts";

test("next and previous move one slide", () => {
  expect({ next: stepSlide(4, 13, 1), previous: stepSlide(4, 13, -1) }).toEqual({ next: 5, previous: 3 });
});

test("the last slide stays the last and the first stays the first", () => {
  expect({ last: stepSlide(12, 13, 1), first: stepSlide(0, 13, -1) }).toEqual({ last: 12, first: 0 });
});

test("a hash with a slide's number opens that slide", () => {
  expect(slideFromHash("#3", 13)).toBe(2);
});

test("no hash, a heading's hash or a number past the last slide opens the first", () => {
  expect([slideFromHash("", 13), slideFromHash("#what-trackwall-is", 13), slideFromHash("#14", 13), slideFromHash("#0", 13)]).toEqual([
    0, 0, 0, 0,
  ]);
});

test("a slide's hash names it by its number from one", () => {
  expect(slideFromHash(hashOfSlide(7), 13)).toBe(7);
  expect(hashOfSlide(0)).toBe("#1");
});
