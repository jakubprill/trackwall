import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANSI_TOKENS, rgbColour, setsDefaultColour, terminalTheme } from "../src/lib/terminal-theme.ts";

const INDEX_CSS = readFileSync(join(import.meta.dir, "..", "src", "index.css"), "utf8");

describe("session terminal theme", () => {
  test("the 16 ANSI colours Copilot CLI draws with come from the app's tokens, not xterm.js's default palette", () => {
    const theme = terminalTheme((name) => `value of ${name}`);
    expect(Object.keys(ANSI_TOKENS)).toHaveLength(16);
    for (const [colour, token] of Object.entries(ANSI_TOKENS))
      expect({ colour, value: theme[colour as keyof typeof theme] }).toEqual({ colour, value: `value of ${token}` });
  });

  test("the terminal has no background of its own, so it takes the surface it sits on", () => {
    expect(terminalTheme(() => "").background).toBe("rgba(0, 0, 0, 0)");
    expect(INDEX_CSS).toMatch(/\.xterm \.xterm-viewport \{\s*background-color: transparent;/);
  });

  test("index.css defines every ANSI token the terminal reads", () => {
    const missing = Object.values(ANSI_TOKENS).filter((token) => !INDEX_CSS.includes(`${token}:`));
    expect(missing).toEqual([]);
  });

  test("a colour reaches xterm.js as rgb() when opaque and rgba() when translucent, the two forms it parses itself", () => {
    expect(rgbColour(34, 40, 49, 255)).toBe("rgb(34, 40, 49)");
    expect(rgbColour(34, 40, 49, 153)).toBe("rgba(34, 40, 49, 0.6)");
    expect(rgbColour(0, 0, 0, 0)).toBe("rgba(0, 0, 0, 0)");
  });

  test("a program's own default text, background and cursor colours are ignored, while its questions about them are answered", () => {
    // What Copilot CLI sends as it starts: GitHub's dark background and text.
    expect(setsDefaultColour("#0D1117")).toBe(true);
    expect(setsDefaultColour("#F0F6FC")).toBe(true);
    expect(setsDefaultColour("rgb:0d0d/1111/1717")).toBe(true);
    // What it asks first, to learn whether the terminal is dark or light.
    expect(setsDefaultColour("?")).toBe(false);
    expect(setsDefaultColour("?;?")).toBe(false);
    expect(setsDefaultColour("?;#0D1117")).toBe(true);
  });
});
