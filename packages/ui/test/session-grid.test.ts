import { describe, expect, test } from "bun:test";
import { gridPage, gridShape, tilesPerPage } from "../src/lib/session-grid.ts";

describe("session grid", () => {
  test("layouts 2 and 4 show that many tiles, Auto the whole list up to nine", () => {
    expect(tilesPerPage("2", 7)).toBe(2);
    expect(tilesPerPage("4", 2)).toBe(4);
    expect(tilesPerPage("auto", 6)).toBe(6);
    expect(tilesPerPage("auto", 14)).toBe(9);
    expect(tilesPerPage("auto", 0)).toBe(1);
  });

  test("the page is the one with the selected entry, so selecting position 6 in layout 4 turns to page 2", () => {
    const list = ["a", "b", "c", "d", "e", "f", "g"];
    expect(gridPage("4", list, 0)).toMatchObject({ page: 0, pages: 2, slots: 4 });
    expect(gridPage("4", list, 5)).toEqual({
      tiles: [
        { entry: "e", position: 5 },
        { entry: "f", position: 6 },
        { entry: "g", position: 7 },
      ],
      slots: 4,
      page: 1,
      pages: 2,
    });
    expect(gridPage("2", list, 3).tiles).toEqual([
      { entry: "c", position: 3 },
      { entry: "d", position: 4 },
    ]);
  });

  test("Auto shows everything on one page, and a longer list goes on in pages of nine", () => {
    expect(gridPage("auto", ["a", "b", "c", "d", "e", "f"], 4)).toMatchObject({ slots: 6, page: 0, pages: 1 });
    const twelve = Array.from({ length: 12 }, (_, i) => i);
    const second = gridPage("auto", twelve, 10);
    expect(second).toMatchObject({ slots: 9, page: 1, pages: 2 });
    expect(second.tiles.map((t) => t.position)).toEqual([10, 11, 12]);
  });

  test("with no selected entry or an empty list the grid shows the first page", () => {
    expect(gridPage("4", ["a", "b", "c", "d", "e"], -1)).toMatchObject({ page: 0, pages: 2 });
    expect(gridPage("auto", [], -1)).toEqual({ tiles: [], slots: 1, page: 0, pages: 1 });
  });

  test("on a 34-inch ultrawide two tiles sit side by side, four in 2 × 2, six in 3 × 2 and eight in 4 × 2", () => {
    const [width, height] = [3100, 1300];
    expect(gridShape(2, width, height)).toEqual({ cols: 2, rows: 1 });
    expect(gridShape(4, width, height)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(6, width, height)).toEqual({ cols: 3, rows: 2 });
    expect(gridShape(8, width, height)).toEqual({ cols: 4, rows: 2 });
    expect(gridShape(9, width, height)).toEqual({ cols: 3, rows: 3 });
  });

  test("in a tall area two tiles stack, and one tile fills the area", () => {
    expect(gridShape(2, 800, 1400)).toEqual({ cols: 1, rows: 2 });
    expect(gridShape(1, 800, 600)).toEqual({ cols: 1, rows: 1 });
  });

  test("before the area is measured the shape is still valid", () => {
    expect(gridShape(4, 0, 0)).toEqual({ cols: 1, rows: 4 });
  });
});
