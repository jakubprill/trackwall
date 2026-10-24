import { describe, expect, test } from "bun:test";
import { sessionTerminalOptions } from "../src/lib/terminal-options.ts";

describe("ustawienia terminala sesji", () => {
  test("Option na macOS wymusza zaznaczanie tekstu, choć Copilot CLI przejął mysz", () => {
    expect(sessionTerminalOptions({}, "monospace")).toMatchObject({ macOptionClickForcesSelection: true, fontFamily: "monospace" });
  });
});
