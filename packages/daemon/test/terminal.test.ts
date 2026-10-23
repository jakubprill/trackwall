import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { terminalPlatform } from "../src/platform/terminal.ts";

/** Otwarte deskryptory daemona; `/dev/fd` jest na macOS i Linuksie, na Windowsie PTY to ConPTY bez deskryptorów. */
function openDescriptors(): number {
  return readdirSync("/dev/fd").length;
}

describe.skipIf(process.versions.bun === undefined || process.platform === "win32")("PTY z Bun.spawn", () => {
  test("po końcu procesu terminal jest zamknięty i nie zostawia deskryptora", async () => {
    const terminals = await terminalPlatform();
    if (!terminals) throw new Error("pod Bun PTY musi być dostępny");
    const before = openDescriptors();
    for (let i = 0; i < 5; i++) {
      let output = "";
      const proc = terminals.spawn({
        command: [process.execPath, "-e", "console.log('koniec')"],
        cwd: tmpdir(),
        env: process.env,
        cols: 80,
        rows: 24,
        onData: (bytes) => {
          output += new TextDecoder().decode(bytes);
        },
      });
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      expect(output).toContain("koniec");
    }
    expect(openDescriptors()).toBeLessThanOrEqual(before);
  });
});
