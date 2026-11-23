import { describe, expect, test } from "bun:test";
import { readHomeOnBar, saveHomeOnBar } from "../src/lib/home-on-bar.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

describe("Home on the view bar (ADR-294)", () => {
  test("a computer that never chose has no Home icon on the view bar", () => {
    expect(readHomeOnBar(() => memoryStorage())).toBe("hidden");
  });

  test("Home shown in Settings stays on the view bar at the next start", () => {
    const storage = memoryStorage();
    saveHomeOnBar(() => storage, "shown");

    expect(readHomeOnBar(() => storage)).toBe("shown");
  });

  test("Home hidden again leaves the view bar at the next start", () => {
    const storage = memoryStorage({ "trackwall.home.bar": "shown" });
    saveHomeOnBar(() => storage, "hidden");

    expect(readHomeOnBar(() => storage)).toBe("hidden");
  });

  test("a value Trackwall does not know, for example from a newer version, reads as hidden", () => {
    expect(readHomeOnBar(() => memoryStorage({ "trackwall.home.bar": "pinned" }))).toBe("hidden");
  });

  test("storage that refuses access reads as hidden, and saving to it does not throw", () => {
    const refusing = () => {
      throw new Error("SecurityError");
    };

    expect(readHomeOnBar(refusing)).toBe("hidden");
    expect(() => saveHomeOnBar(refusing, "shown")).not.toThrow();
  });
});
