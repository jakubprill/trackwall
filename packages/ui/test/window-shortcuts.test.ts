import { describe, expect, test } from "bun:test";
import { listenForShortcuts, shortcutHandler } from "../src/lib/window-shortcuts.ts";

function keyEvent(key: string) {
  const calls: string[] = [];
  return { key, calls, preventDefault: () => calls.push("preventDefault"), stopPropagation: () => calls.push("stopPropagation") };
}

describe("window shortcuts", () => {
  test("a handled shortcut is stopped, so the session terminal never gets the key", () => {
    const handled: string[] = [];
    const onKeyDown = shortcutHandler(
      (event: ReturnType<typeof keyEvent>) => (event.key === "3" ? "sessions" : undefined),
      (view) => {
        handled.push(view);
        return true;
      },
    );
    const press = keyEvent("3");
    onKeyDown(press);
    expect(handled).toEqual(["sessions"]);
    expect(press.calls).toEqual(["preventDefault", "stopPropagation"]);
  });

  test("a key that is no shortcut, or a shortcut the handler declines, stays an ordinary key press", () => {
    const onKeyDown = shortcutHandler(
      (event: ReturnType<typeof keyEvent>) => (event.key === "j" ? "next-waiting" : undefined),
      () => false,
    );
    const other = keyEvent("x");
    const declined = keyEvent("j");
    onKeyDown(other);
    onKeyDown(declined);
    expect(other.calls).toEqual([]);
    expect(declined.calls).toEqual([]);
  });

  test("the listener runs in the capture phase, before xterm.js can stop the event in the terminal", () => {
    const registered: unknown[][] = [];
    const target = {
      addEventListener: (...args: unknown[]) => registered.push(["add", ...args]),
      removeEventListener: (...args: unknown[]) => registered.push(["remove", ...args]),
    } as unknown as Window;
    const onKeyDown = () => {};
    const stop = listenForShortcuts(target, onKeyDown);
    stop();
    expect(registered).toEqual([
      ["add", "keydown", onKeyDown, { capture: true }],
      ["remove", "keydown", onKeyDown, { capture: true }],
    ]);
  });
});
