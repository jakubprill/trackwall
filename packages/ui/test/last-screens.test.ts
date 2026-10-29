import { describe, expect, test } from "bun:test";
import { LastScreens } from "../src/lib/last-screens.ts";

describe("the screen a session terminal showed when it closed", () => {
  test("comes back for a terminal of the same session in the same width", () => {
    const screens = new LastScreens();
    screens.keep("s1", { cols: 120, screen: "● Ran the tests" });

    expect(screens.shown("s1", 120)).toBe("● Ran the tests");
    expect(screens.shown("s2", 120)).toBeUndefined();
  });

  test("does not come back in another width, where its lines would wrap", () => {
    const screens = new LastScreens();
    screens.keep("s1", { cols: 120, screen: "● Ran the tests" });

    expect(screens.shown("s1", 100)).toBeUndefined();
  });

  test("is the one kept last", () => {
    const screens = new LastScreens();
    screens.keep("s1", { cols: 120, screen: "first" });
    screens.keep("s1", { cols: 120, screen: "second" });

    expect(screens.shown("s1", 120)).toBe("second");
  });

  test("of 50 sessions at most: the session whose screen was kept longest ago loses it first", () => {
    const screens = new LastScreens();
    for (let i = 0; i < 50; i++) screens.keep(`s${i}`, { cols: 80, screen: `screen ${i}` });
    screens.keep("s0", { cols: 80, screen: "screen 0 again" });
    screens.keep("s50", { cols: 80, screen: "screen 50" });

    expect(screens.shown("s1", 80)).toBeUndefined();
    expect(screens.shown("s0", 80)).toBe("screen 0 again");
    expect(screens.shown("s2", 80)).toBe("screen 2");
    expect(screens.shown("s50", 80)).toBe("screen 50");
  });
});
