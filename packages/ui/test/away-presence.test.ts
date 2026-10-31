import { describe, expect, test } from "bun:test";
import {
  AWAY_AFTER_MS,
  AWAY_KEY,
  absenceAt,
  LAST_ACTIVE_KEY,
  PRESENCE_WRITE_MS,
  pointerMoved,
  presenceSign,
  readAway,
  readLastActive,
  saveAway,
  saveLastActive,
} from "../src/lib/away-presence.ts";

const NINE = Date.parse("2026-10-31T09:00:00.000Z");

function memoryStorage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const refusing = () => {
  throw new Error("SecurityError: the operation is insecure");
};

describe("an absence from Trackwall (ADR-151)", () => {
  test("opens with the first sign of the user 15 minutes or more after the last one, from that last one to now", () => {
    expect(absenceAt(NINE, NINE + AWAY_AFTER_MS - 1, undefined)).toBeUndefined();
    expect(absenceAt(NINE, NINE + AWAY_AFTER_MS, undefined)).toEqual({
      from: "2026-10-31T09:00:00.000Z",
      to: "2026-10-31T09:15:00.000Z",
    });
  });

  test("is not opened without a last sign: a window opened for the first time knows of no absence", () => {
    expect(absenceAt(undefined, NINE, undefined)).toBeUndefined();
  });

  test("not dismissed yet keeps its start when a next one opens, so the summary covers both", () => {
    const open = { from: "2026-10-31T08:00:00.000Z", to: "2026-10-31T08:30:00.000Z" };

    expect(absenceAt(NINE, NINE + 2 * AWAY_AFTER_MS, open)).toEqual({ from: "2026-10-31T08:00:00.000Z", to: "2026-10-31T09:30:00.000Z" });
  });
});

describe("the absence and the last sign in localStorage, which all windows of the origin share", () => {
  test("are written and read back, and a dismissal clears the absence", () => {
    const storage = memoryStorage();
    saveLastActive(() => storage, NINE);
    saveAway(() => storage, { from: "2026-10-31T08:00:00.000Z", to: "2026-10-31T09:00:00.000Z" });

    expect(readLastActive(() => storage)).toBe(NINE);
    expect(readAway(() => storage)).toEqual({ from: "2026-10-31T08:00:00.000Z", to: "2026-10-31T09:00:00.000Z" });

    saveAway(() => storage, undefined);
    expect(readAway(() => storage)).toBeUndefined();
  });

  test("anything else under the keys reads as nothing", () => {
    const storage = memoryStorage({ [LAST_ACTIVE_KEY]: "yesterday", [AWAY_KEY]: '{"from":"<img src=x>"}' });

    expect(readLastActive(() => storage)).toBeUndefined();
    expect(readAway(() => storage)).toBeUndefined();
  });

  test("storage that refuses access reads as nothing and a write to it is forgotten", () => {
    expect(readLastActive(refusing)).toBeUndefined();
    expect(readAway(refusing)).toBeUndefined();
    expect(() => saveLastActive(refusing, NINE)).not.toThrow();
    expect(() => saveAway(refusing, undefined)).not.toThrow();
  });
});

describe("one sign of the user in a window", () => {
  const nothingStored = () => ({ lastActive: undefined, away: undefined });

  test("soon after this window's last one reads no storage and writes at most every 30 seconds", () => {
    const memory = { away: undefined, lastActive: NINE, written: NINE };
    const reads: string[] = [];
    const stored = () => {
      reads.push("read");
      return nothingStored();
    };

    expect(presenceSign(memory, NINE + PRESENCE_WRITE_MS - 1, stored)).toMatchObject({ opened: undefined, write: false });
    expect(presenceSign(memory, NINE + PRESENCE_WRITE_MS, stored)).toMatchObject({ opened: undefined, write: true });
    expect(reads).toEqual([]);
  });

  test("after a long gap here counts the newer sign another window stored, so using another window is not an absence", () => {
    const memory = { away: undefined, lastActive: NINE, written: NINE };
    const later = NINE + 2 * AWAY_AFTER_MS;

    const other = presenceSign(memory, later, () => ({ lastActive: later - 60_000, away: undefined }));
    expect(other).toMatchObject({ opened: undefined, write: true });

    const none = presenceSign(memory, later, nothingStored);
    expect(none.opened).toEqual({ from: "2026-10-31T09:00:00.000Z", to: "2026-10-31T09:30:00.000Z" });
    expect(none.memory).toEqual({ away: none.opened, lastActive: later, written: later });
  });

  test("a pointer that stands still while the page moves under it is no sign", () => {
    expect(pointerMoved(undefined, 10, 20)).toBe(true);
    expect(pointerMoved({ x: 10, y: 20 }, 10, 20)).toBe(false);
    expect(pointerMoved({ x: 10, y: 20 }, 11, 20)).toBe(true);
  });
});
