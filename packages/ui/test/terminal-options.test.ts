import { describe, expect, test } from "bun:test";
import { sessionTerminalOptions } from "../src/lib/terminal-options.ts";

describe("session terminal options", () => {
  test("Option on macOS forces text selection even though Copilot CLI has taken the mouse", () => {
    expect(sessionTerminalOptions({}, "monospace")).toMatchObject({ macOptionClickForcesSelection: true, fontFamily: "monospace" });
  });

  test("the terminal may be transparent, so it takes the surface it sits on", () => {
    expect(sessionTerminalOptions({}, "monospace").allowTransparency).toBe(true);
  });
});
