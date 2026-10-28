import { describe, expect, test } from "bun:test";
import { readHomeSceneSettings, saveHomeSceneSettings } from "../src/lib/home-scene-settings.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

describe("Home scene settings (ADR-104)", () => {
  test("a computer that never chose gets holograms with every repo named", () => {
    expect(readHomeSceneSettings(() => memoryStorage())).toEqual({ style: "holo", labels: "all" });
  });

  test("a saved choice is read back on the next start", () => {
    const storage = memoryStorage();
    saveHomeSceneSettings(() => storage, { style: "orbs", labels: "needs-you" });

    expect(readHomeSceneSettings(() => storage)).toEqual({ style: "orbs", labels: "needs-you" });
  });

  test("a value Trackwall does not know, for example from a newer version, reads as the default", () => {
    const storage = memoryStorage({ "trackwall.home.style": "pylons", "trackwall.home.labels": "needs-you" });

    expect(readHomeSceneSettings(() => storage)).toEqual({ style: "holo", labels: "needs-you" });
  });

  test("storage that refuses access reads as the default, and saving to it does not throw", () => {
    const refusing = () => {
      throw new Error("SecurityError");
    };

    expect(readHomeSceneSettings(refusing)).toEqual({ style: "holo", labels: "all" });
    expect(() => saveHomeSceneSettings(refusing, { style: "orbs", labels: "all" })).not.toThrow();
  });
});
