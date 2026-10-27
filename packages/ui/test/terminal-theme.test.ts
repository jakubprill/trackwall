import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANSI_TOKENS, terminalTheme } from "../src/lib/terminal-theme.ts";

const INDEX_CSS = readFileSync(join(import.meta.dir, "..", "src", "index.css"), "utf8");

describe("session terminal theme", () => {
  test("the 16 ANSI colours Copilot CLI draws with come from the app's tokens, not xterm.js's default palette", () => {
    const theme = terminalTheme((name) => `value of ${name}`);
    expect(theme.background).toBe("value of --background");
    expect(Object.keys(ANSI_TOKENS)).toHaveLength(16);
    for (const [colour, token] of Object.entries(ANSI_TOKENS))
      expect({ colour, value: theme[colour as keyof typeof theme] }).toEqual({ colour, value: `value of ${token}` });
  });

  test("index.css defines every ANSI token the terminal reads", () => {
    const missing = Object.values(ANSI_TOKENS).filter((token) => !INDEX_CSS.includes(`${token}:`));
    expect(missing).toEqual([]);
  });
});
