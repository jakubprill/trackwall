import { describe, expect, test } from "bun:test";
import { isNewComputer, readSeenWhatsNew, saveAllWhatsNewSeen, WHATS_NEW, WHATS_NEW_MOST, whatsNewEntries } from "../src/lib/whats-new.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

const ids = (entries: ReturnType<typeof whatsNewEntries>) => entries?.map((entry) => entry.id);

describe("What's new (ADR-296)", () => {
  test("after an update, a computer that never dismissed it lists every entry, newest first", () => {
    expect(ids(whatsNewEntries(null, false))).toEqual(WHATS_NEW.map((entry) => entry.id));
    expect(ids(whatsNewEntries(null, false))?.[0]).toBe("plan-and-knowledge-in-the-store");
  });

  test("a computer that dismissed What's new lists only the entries a later update added", () => {
    const dismissedBefore = new Set(WHATS_NEW.filter((entry) => entry.id !== "sync-main-in-new-task").map((entry) => entry.id));

    expect(ids(whatsNewEntries(dismissedBefore, false))).toEqual(["sync-main-in-new-task"]);
    expect(ids(whatsNewEntries(new Set(WHATS_NEW.map((entry) => entry.id)), false))).toEqual([]);
  });

  test("a new install lists none, and nothing shows while the daemon has not said whether the computer is new", () => {
    expect(whatsNewEntries(null, true)).toEqual([]);
    expect(whatsNewEntries(null, undefined)).toBeUndefined();
  });

  test("a computer is new while its daemon has no projects folder, and not known to be until the daemon says", () => {
    expect(isNewComputer(null)).toBe(true);
    expect(isNewComputer("/home/dev/projects")).toBe(false);
    expect(isNewComputer(undefined)).toBeUndefined();
  });

  test("once the seen entries are stored, the strip no longer waits for the daemon", () => {
    expect(ids(whatsNewEntries(new Set(), undefined))).toEqual(WHATS_NEW.map((entry) => entry.id));
  });

  test("the list holds at most six entries, so the strip never pushes the views far down, each with an id of its own", () => {
    expect(WHATS_NEW.length).toBeLessThanOrEqual(WHATS_NEW_MOST);
    expect(new Set(WHATS_NEW.map((entry) => entry.id)).size).toBe(WHATS_NEW.length);
  });

  test("Dismiss stores every entry as seen, and the next start reads them back", () => {
    const storage = memoryStorage();
    expect(readSeenWhatsNew(() => storage)).toBeNull();

    saveAllWhatsNewSeen(() => storage);

    expect(readSeenWhatsNew(() => storage)).toEqual(new Set(WHATS_NEW.map((entry) => entry.id)));
  });

  test("a stored value that is not a list of entries, or storage that refuses access, reads as never stored", () => {
    const refusing = () => {
      throw new Error("SecurityError");
    };

    expect(readSeenWhatsNew(() => memoryStorage({ "trackwall.whats-new.seen": '{"tips": true}' }))).toBeNull();
    expect(readSeenWhatsNew(refusing)).toBeNull();
    expect(() => saveAllWhatsNewSeen(refusing)).not.toThrow();
  });
});
