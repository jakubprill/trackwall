import { describe, expect, test } from "bun:test";
import { DEFAULT_START_CHOICE, readStartChoice, saveStartChoice } from "../src/lib/start-choices.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

describe("the start options the New session form remembers for each place", () => {
  test("a place never started from gets its own worktree, the default model and no Java navigation", () => {
    const storage = memoryStorage();
    expect(readStartChoice(() => storage, "shop")).toEqual({ worktree: true, model: "", javaNavigation: false });
  });

  test("the choice saved for one repo comes back for it and leaves the other places at the defaults", () => {
    const storage = memoryStorage();
    saveStartChoice(() => storage, "shop", { worktree: false, model: "gpt-5.5", javaNavigation: true });
    saveStartChoice(() => storage, "", { worktree: true, model: "claude-opus-5.5", javaNavigation: false });
    expect(readStartChoice(() => storage, "shop")).toEqual({ worktree: false, model: "gpt-5.5", javaNavigation: true });
    expect(readStartChoice(() => storage, "")).toEqual({ worktree: true, model: "claude-opus-5.5", javaNavigation: false });
    expect(readStartChoice(() => storage, "billing")).toEqual(DEFAULT_START_CHOICE);
  });

  test("a choice saved before Java navigation keeps its worktree and model, without navigation", () => {
    const storage = memoryStorage({ "trackwall.start-choices": JSON.stringify({ shop: { worktree: false, model: "gpt-5.5" } }) });
    expect(readStartChoice(() => storage, "shop")).toEqual({ worktree: false, model: "gpt-5.5", javaNavigation: false });
  });

  test("a stored value of another shape, such as one with an approvals mode, reads as the defaults", () => {
    const storage = memoryStorage({ "trackwall.start-choices": JSON.stringify({ shop: { worktree: true, approvals: "auto" } }) });
    expect(readStartChoice(() => storage, "shop")).toEqual(DEFAULT_START_CHOICE);
    const broken = memoryStorage({ "trackwall.start-choices": "{not json" });
    expect(readStartChoice(() => broken, "shop")).toEqual(DEFAULT_START_CHOICE);
  });

  test("a storage that throws reads as the defaults, and saving to it does not throw", () => {
    const failing = () => {
      throw new Error("storage is blocked");
    };
    expect(readStartChoice(failing, "shop")).toEqual(DEFAULT_START_CHOICE);
    expect(() => saveStartChoice(failing, "shop", { worktree: false, model: "", javaNavigation: false })).not.toThrow();
  });
});
