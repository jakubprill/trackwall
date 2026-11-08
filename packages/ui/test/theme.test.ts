import { describe, expect, test } from "bun:test";
import { readThemeChoice, resolveTheme, saveThemeChoice } from "../src/lib/theme.ts";
import { ThemeController, type ThemeEnvironment } from "../src/lib/theme-controller.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

/** A window: its storage, the system's scheme, the attribute on `<html>`, the `storage` events and what the shell was told. */
function fakeWindow({ stored = {}, systemLight = false }: { stored?: Record<string, string>; systemLight?: boolean } = {}) {
  const storage = memoryStorage(stored);
  const schemeListeners: Array<() => void> = [];
  const storageListeners: Array<(key: string | null) => void> = [];
  const page = { attribute: "", toldShell: [] as string[] };
  const system = { matches: systemLight };
  const environment: ThemeEnvironment = {
    storage: () => storage,
    systemLight: {
      get matches() {
        return system.matches;
      },
      addEventListener: (_type: string, listener: () => void) => void schemeListeners.push(listener),
    } as ThemeEnvironment["systemLight"],
    onStorage: (listener) => void storageListeners.push(listener),
    root: {
      setAttribute: (_name: string, value: string) => {
        page.attribute = value;
      },
    },
    tellShell: async (choice) => void page.toldShell.push(choice),
  };
  return {
    storage,
    environment,
    page,
    switchSystem(light: boolean) {
      system.matches = light;
      for (const listener of schemeListeners) listener();
    },
    storageEvent(key: string | null) {
      for (const listener of storageListeners) listener(key);
    },
  };
}

describe("theme choice (ADR-235)", () => {
  test("a computer that never chose gets the dark theme, so an update does not turn the app light", () => {
    expect(readThemeChoice(() => memoryStorage())).toBe("dark");
  });

  test("a saved choice is read back on the next start", () => {
    const storage = memoryStorage();
    saveThemeChoice(() => storage, "system");

    expect(readThemeChoice(() => storage)).toBe("system");
  });

  test("a value Trackwall does not know, for example from a newer version, reads as dark", () => {
    expect(readThemeChoice(() => memoryStorage({ "trackwall.theme": "sepia" }))).toBe("dark");
  });

  test("storage that refuses access reads as dark, and saving to it does not throw", () => {
    const refusing = () => {
      throw new Error("SecurityError");
    };

    expect(readThemeChoice(refusing)).toBe("dark");
    expect(() => saveThemeChoice(refusing, "light")).not.toThrow();
  });

  test("dark and light are what they say whatever the system is; system is the system's scheme", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });
});

describe("a window's theme (ADR-235)", () => {
  test("the page is painted in the saved theme as soon as the controller starts, and the shell is told the choice", () => {
    const window = fakeWindow({ stored: { "trackwall.theme": "light" } });

    new ThemeController(window.environment);

    expect(window.page.attribute).toBe("light");
    expect(window.page.toldShell).toEqual(["light"]);
  });

  test("choosing a theme repaints the page, saves it and tells the shell", () => {
    const window = fakeWindow();
    const controller = new ThemeController(window.environment);

    controller.choose("light");

    expect(window.page.attribute).toBe("light");
    expect(window.storage.getItem("trackwall.theme")).toBe("light");
    expect(window.page.toldShell).toEqual(["dark", "light"]);
  });

  test("with the system's theme the page follows the system live, and a fixed choice does not", () => {
    const window = fakeWindow({ stored: { "trackwall.theme": "system" }, systemLight: false });
    const controller = new ThemeController(window.environment);
    expect(window.page.attribute).toBe("dark");

    window.switchSystem(true);
    expect(window.page.attribute).toBe("light");

    controller.choose("dark");
    window.switchSystem(false);
    window.switchSystem(true);
    expect(window.page.attribute).toBe("dark");
  });

  test("a choice made in another window reaches this one through the storage event", () => {
    const window = fakeWindow();
    const controller = new ThemeController(window.environment);
    const heard: string[] = [];
    controller.subscribe(() => heard.push(controller.theme));

    window.storage.setItem("trackwall.theme", "light");
    window.storageEvent("trackwall.theme");

    expect(window.page.attribute).toBe("light");
    expect(heard).toEqual(["light"]);
  });

  test("a storage event for another key leaves the theme alone", () => {
    const window = fakeWindow();
    new ThemeController(window.environment);

    window.storage.setItem("trackwall.theme", "light");
    window.storageEvent("trackwall.home.style");

    expect(window.page.attribute).toBe("dark");
  });
});
