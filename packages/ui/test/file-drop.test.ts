import { describe, expect, test } from "bun:test";
import { cssPoint, dropTargetAt, FILE_DROP_TARGET, FileDropEvent, pastedPaths } from "../src/lib/file-drop.ts";

describe("file drop", () => {
  test("the shell's physical point becomes CSS pixels by the device pixel ratio", () => {
    expect(cssPoint({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
    expect(cssPoint({ x: 300, y: 150 }, 1)).toEqual({ x: 300, y: 150 });
  });

  test("dropped paths are pasted separated by spaces with one after them, quoted when they have a space or a quote", () => {
    expect(pastedPaths(["/Users/me/Projects/shop/README.md"])).toBe("/Users/me/Projects/shop/README.md ");
    expect(pastedPaths(["C:\\Users\\me\\My Projects\\a.txt", "C:\\b.txt"])).toBe('"C:\\Users\\me\\My Projects\\a.txt" C:\\b.txt ');
    expect(pastedPaths(['/tmp/say "hi".txt', "/tmp/it's.txt"])).toBe('"/tmp/say \\"hi\\".txt" "/tmp/it\'s.txt" ');
  });

  test("the drop target is the marked element that holds the point, and none when nothing marked holds it", () => {
    const target = {
      closest: (selector: string) => (selector === `[${FILE_DROP_TARGET}]` ? ({ id: "terminal" } as unknown as Element) : null),
    };
    const plain = { closest: () => null };

    expect(dropTargetAt({ elementFromPoint: () => target as unknown as Element }, { x: 1, y: 1 })).toEqual({
      id: "terminal",
    } as unknown as Element);
    expect(dropTargetAt({ elementFromPoint: () => plain as unknown as Element }, { x: 1, y: 1 })).toBeUndefined();
    expect(dropTargetAt({ elementFromPoint: () => null }, { x: 1, y: 1 })).toBeUndefined();
  });

  test("a target takes the dropped paths by cancelling the event, so the page knows nobody else should", () => {
    const terminal = new EventTarget();
    const taken: (readonly string[])[] = [];
    terminal.addEventListener(FileDropEvent.type, (event) => {
      if (!(event instanceof FileDropEvent)) return;
      event.preventDefault();
      taken.push(event.paths);
    });
    const event = new FileDropEvent(["/a.txt"]);

    terminal.dispatchEvent(event);

    expect(taken).toEqual([["/a.txt"]]);
    expect(event.defaultPrevented).toBe(true);
    expect(new FileDropEvent(["/b.txt"]).defaultPrevented).toBe(false);
  });
});
