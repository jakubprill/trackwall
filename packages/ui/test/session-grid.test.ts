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

  test("the page is the one with the focused entry, so focusing position 6 in layout 4 turns to page 2", () => {
    expect(gridPage("4", 7, 0)).toEqual({ start: 0, count: 4, page: 0, pages: 2 });
    expect(gridPage("4", 7, 5)).toEqual({ start: 4, count: 3, page: 1, pages: 2 });
    expect(gridPage("2", 7, 3)).toEqual({ start: 2, count: 2, page: 1, pages: 4 });
  });

  test("Auto shows everything on one page, and a longer list goes on in pages of nine", () => {
    expect(gridPage("auto", 6, 4)).toEqual({ start: 0, count: 6, page: 0, pages: 1 });
    expect(gridPage("auto", 12, 10)).toEqual({ start: 9, count: 3, page: 1, pages: 2 });
  });

  test("with no focused entry or an empty list the grid shows the first page", () => {
    expect(gridPage("4", 7, -1)).toEqual({ start: 0, count: 4, page: 0, pages: 2 });
    expect(gridPage("auto", 0, -1)).toEqual({ start: 0, count: 0, page: 0, pages: 1 });
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
