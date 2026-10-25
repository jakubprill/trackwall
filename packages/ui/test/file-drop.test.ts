import { describe, expect, test } from "bun:test";
import { cssPoint, DROP_HOVER, DROP_HOVER_RING, dragStep, dropTargetAt, FILE_DROP_TARGET } from "../src/lib/file-drop.ts";

describe("file drop", () => {
  test("the drop point is divided by the device pixel ratio only on Windows, where WebView2 gives physical pixels", () => {
    expect(cssPoint({ x: 300, y: 150 }, true, 1.5)).toEqual({ x: 200, y: 100 });
    expect(cssPoint({ x: 300, y: 150 }, false, 2)).toEqual({ x: 300, y: 150 });
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

  test("the highlight classes name the attribute set on the hovered target", () => {
    for (const cls of DROP_HOVER_RING.split(" ")) expect(cls.startsWith(`data-[${DROP_HOVER.slice("data-".length)}]:`)).toBe(true);
  });

  test("a drag with files hovers and then delivers its paths on drop", () => {
    const enter = dragStep(false, { type: "enter", paths: ["/a.txt", "/b.txt"] });
    expect(enter).toEqual({ carriesFiles: true, action: { kind: "hover" } });
    expect(dragStep(enter.carriesFiles, { type: "over" })).toEqual({ carriesFiles: true, action: { kind: "hover" } });
    expect(dragStep(true, { type: "drop", paths: ["/a.txt", "/b.txt"] })).toEqual({
      carriesFiles: false,
      action: { kind: "drop", paths: ["/a.txt", "/b.txt"] },
    });
  });

  test("a drag without files (text, a link, an image) never hovers and its drop does nothing", () => {
    const enter = dragStep(false, { type: "enter", paths: [] });
    expect(enter).toEqual({ carriesFiles: false, action: { kind: "stop" } });
    expect(dragStep(enter.carriesFiles, { type: "over" }).action).toEqual({ kind: "stop" });
    expect(dragStep(enter.carriesFiles, { type: "drop", paths: [] }).action).toEqual({ kind: "stop" });
  });

  test("leaving the window stops the drag", () => {
    expect(dragStep(true, { type: "leave" })).toEqual({ carriesFiles: false, action: { kind: "stop" } });
  });
});
