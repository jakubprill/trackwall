import { expect, test } from "bun:test";
import { hashOfSlide, isTypingInto, slideFromHash, slideKeyDirection, stepSlide } from "../.vitepress/theme/slides.ts";

test("a clicker's Page Down, the right arrow and J go forward; Page Up, the left arrow and K go back", () => {
  expect(["PageDown", "ArrowRight", "j", "J"].map(slideKeyDirection)).toEqual([1, 1, 1, 1]);
  expect(["PageUp", "ArrowLeft", "k", "K"].map(slideKeyDirection)).toEqual([-1, -1, -1, -1]);
});

test("the up and down arrows and Space keep scrolling a slide taller than the window", () => {
  expect(["ArrowDown", "ArrowUp", " ", "Enter"].map(slideKeyDirection)).toEqual([undefined, undefined, undefined, undefined]);
});

test("keys typed into a field stay there, and keys on the page or a button move the deck", () => {
  expect({
    search: isTypingInto({ tagName: "INPUT", isContentEditable: false }),
    editable: isTypingInto({ tagName: "DIV", isContentEditable: true }),
    button: isTypingInto({ tagName: "BUTTON", isContentEditable: false }),
    nothing: isTypingInto(null),
  }).toEqual({ search: true, editable: true, button: false, nothing: false });
});

test("next and previous move one slide", () => {
  expect({ next: stepSlide(4, 13, 1), previous: stepSlide(4, 13, -1) }).toEqual({ next: 5, previous: 3 });
});

test("the last slide stays the last and the first stays the first", () => {
  expect({ last: stepSlide(12, 13, 1), first: stepSlide(0, 13, -1) }).toEqual({ last: 12, first: 0 });
});

test("a hash with a slide's number names that slide", () => {
  expect(slideFromHash("#3", 13)).toBe(2);
});

test("no hash, a heading's hash or a number outside the talk names no slide", () => {
  expect(["", "#", "#what-trackwall-is", "#14", "#0", "#2.5"].map((hash) => slideFromHash(hash, 13))).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("a slide's hash names it by its number from one", () => {
  expect(slideFromHash(hashOfSlide(7), 13)).toBe(7);
  expect(hashOfSlide(0)).toBe("#1");
});
