import { describe, expect, test } from "bun:test";
import { KEY_ANSWER_AFTER_MS, keyAnswerTooSoon, optionAfterKey, writingIn } from "../src/lib/dialog-keyboard.ts";

describe("the keys that move between an approval's options", () => {
  test("the arrows move to the next and the previous option and stop at the ends", () => {
    expect(optionAfterKey("ArrowDown", 0, 4)).toBe(1);
    expect(optionAfterKey("ArrowUp", 1, 4)).toBe(0);
    expect(optionAfterKey("ArrowUp", 0, 4)).toBe(0);
    expect(optionAfterKey("ArrowDown", 3, 4)).toBe(3);
  });

  test("Home and End go to the first and the last option", () => {
    expect(optionAfterKey("Home", 2, 4)).toBe(0);
    expect(optionAfterKey("End", 1, 4)).toBe(3);
  });

  test("other keys, Enter and Tab among them, do not move, so the browser handles them", () => {
    expect(optionAfterKey("Enter", 0, 4)).toBeUndefined();
    expect(optionAfterKey("Tab", 0, 4)).toBeUndefined();
    expect(optionAfterKey("ArrowLeft", 1, 4)).toBeUndefined();
  });

  test("with no options no key moves", () => {
    expect(optionAfterKey("ArrowDown", 0, 0)).toBeUndefined();
  });
});

describe("whether the user is writing when an approval shows", () => {
  test("a message box with text in it keeps the keyboard", () => {
    expect(writingIn({ tagName: "TEXTAREA", value: "check the bu" })).toBe(true);
    expect(writingIn({ tagName: "INPUT", type: "text", value: "x" })).toBe(true);
  });

  test("an empty message box, a checkbox, a button or no focused element gives the keyboard to the approval", () => {
    expect(writingIn({ tagName: "TEXTAREA", value: "" })).toBe(false);
    expect(writingIn({ tagName: "INPUT", type: "checkbox", value: "on" })).toBe(false);
    expect(writingIn({ tagName: "BUTTON", value: "" })).toBe(false);
    expect(writingIn({ tagName: "BODY" })).toBe(false);
    expect(writingIn(null)).toBe(false);
  });
});

describe("an answer given with a key right after the approval shows", () => {
  test("Enter in the first moment, meant for the message just sent, does not answer", () => {
    expect(keyAnswerTooSoon(true, 120)).toBe(true);
  });

  test("Enter once the approval has shown for a moment answers", () => {
    expect(keyAnswerTooSoon(true, KEY_ANSWER_AFTER_MS)).toBe(false);
  });

  test("a click answers at once, since the user aimed at the option", () => {
    expect(keyAnswerTooSoon(false, 0)).toBe(false);
  });
});
