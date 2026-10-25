import { expect, test } from "bun:test";
import { zoomStepOf } from "../src/lib/zoom-shortcut.ts";

const press = (key: string, code: string, modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: modifiers.ctrl ?? false,
  metaKey: modifiers.meta ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
});

test("Ctrl+= and Ctrl++ zoom in, Ctrl+- zooms out and Ctrl+0 goes back to actual size", () => {
  expect(zoomStepOf(press("=", "Equal", { ctrl: true }), false)).toBe("in");
  expect(zoomStepOf(press("+", "Equal", { ctrl: true, shift: true }), false)).toBe("in");
  expect(zoomStepOf(press("+", "NumpadAdd", { ctrl: true }), false)).toBe("in");
  expect(zoomStepOf(press("-", "Minus", { ctrl: true }), false)).toBe("out");
  expect(zoomStepOf(press("-", "NumpadSubtract", { ctrl: true }), false)).toBe("out");
  expect(zoomStepOf(press("0", "Digit0", { ctrl: true }), false)).toBe("reset");
});

test("on macOS the zoom keys go with ⌘, not Ctrl", () => {
  expect(zoomStepOf(press("=", "Equal", { meta: true }), true)).toBe("in");
  expect(zoomStepOf(press("=", "Equal", { ctrl: true }), true)).toBeUndefined();
  expect(zoomStepOf(press("=", "Equal", { meta: true }), false)).toBeUndefined();
});

test("zero is found by its key, so Ctrl+0 resets on AZERTY too", () => {
  expect(zoomStepOf(press("à", "Digit0", { ctrl: true }), false)).toBe("reset");
});

test("the keypad zero resets only with NumLock on, since without it the key is Insert and Ctrl+Insert copies", () => {
  expect(zoomStepOf(press("0", "Numpad0", { ctrl: true }), false)).toBe("reset");
  expect(zoomStepOf(press("Insert", "Numpad0", { ctrl: true }), false)).toBeUndefined();
});

test("other keys and Alt or AltGr combinations do not zoom", () => {
  expect(zoomStepOf(press("=", "Equal"), false)).toBeUndefined();
  expect(zoomStepOf(press("1", "Digit1", { ctrl: true }), false)).toBeUndefined();
  expect(zoomStepOf(press("0", "Digit0", { ctrl: true, alt: true }), false)).toBeUndefined();
  expect(zoomStepOf(press(")", "Digit0", { ctrl: true, shift: true }), false)).toBeUndefined();
});
