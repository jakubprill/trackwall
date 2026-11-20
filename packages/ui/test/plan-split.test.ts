import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PANEL_SHARE,
  LIST_MIN_PX,
  PANEL_MIN_PX,
  PLAN_SPLIT_KEY,
  panelWidth,
  readPanelShare,
  savePanelShare,
  shareAt,
} from "../src/lib/plan-split";

describe("the split of Plan between the list and the panel", () => {
  test("by default the panel takes half of a wide screen, three times what its fixed column gave", () => {
    // 1920 px window: 48 px view bar, 224 px left column, 48 px folded supervisor bar.
    const area = 1920 - 48 - 224 - 48;
    expect(panelWidth(area, DEFAULT_PANEL_SHARE)).toBe(800);
  });

  test("the panel never gets narrower than its old fixed column while the list has room", () => {
    expect(panelWidth(1000, 0.1)).toBe(PANEL_MIN_PX);
  });

  test("the list keeps room for its titles first: on a laptop with the supervisor open the panel gives way", () => {
    // 1440 px window with the supervisor panel open leaves about 650 px for the list and the panel.
    expect(panelWidth(650, 0.9)).toBe(650 - LIST_MIN_PX);
    expect(650 - panelWidth(650, DEFAULT_PANEL_SHARE)).toBeGreaterThanOrEqual(LIST_MIN_PX);
  });

  test("an area narrower than both minimums gives the list its minimum and the panel the rest", () => {
    expect(panelWidth(500, DEFAULT_PANEL_SHARE)).toBe(500 - LIST_MIN_PX);
    expect(panelWidth(200, DEFAULT_PANEL_SHARE)).toBe(0);
  });

  test("dragging the divider to a point gives the panel what lies right of it", () => {
    expect(shareAt(1000, 300)).toBe(0.7);
    expect(shareAt(1000, 990)).toBe(0.1);
    expect(shareAt(1000, -50)).toBe(0.9);
    expect(shareAt(0, 10)).toBe(DEFAULT_PANEL_SHARE);
  });

  test("the share is remembered on this computer and read back", () => {
    const store = new Map<string, string>();
    const storage = () => ({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    expect(readPanelShare(storage)).toBe(DEFAULT_PANEL_SHARE);
    savePanelShare(storage, 0.65);
    expect(store.get(PLAN_SPLIT_KEY)).toBe("0.65");
    expect(readPanelShare(storage)).toBe(0.65);
  });

  test("a stored value out of range, not a number or unreadable storage reads as half and half", () => {
    for (const stored of ["0.99", "-1", "wide", ""]) expect(readPanelShare(() => ({ getItem: () => stored }))).toBe(DEFAULT_PANEL_SHARE);
    const refusing = () => {
      throw new Error("storage is off");
    };
    expect(readPanelShare(refusing)).toBe(DEFAULT_PANEL_SHARE);
    expect(() => savePanelShare(refusing, 0.6)).not.toThrow();
  });
});
