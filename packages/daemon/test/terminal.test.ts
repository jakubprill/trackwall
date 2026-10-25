import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { terminalPlatform } from "../src/platform/terminal.ts";

/** The daemon's open descriptors; `/dev/fd` exists on macOS and Linux, on Windows the PTY is ConPTY without descriptors. */
function openDescriptors(): number {
  return readdirSync("/dev/fd").length;
}

const STARTS = 20;

describe.skipIf(process.versions.bun === undefined || process.platform === "win32")("PTY from Bun.spawn", () => {
  test("after the process ends the terminal is closed and leaves no descriptor", async () => {
    const terminals = await terminalPlatform();
    if (!terminals) throw new Error("under Bun the PTY must be available");
    // The first start may open descriptors of Bun itself, so we count only from the second. Other tests in the same
    // process may still be closing their sockets, so what counts is growth smaller than the number of starts, not zero.
    let before = 0;
    for (let i = 0; i <= STARTS; i++) {
      if (i === 1) before = openDescriptors();
      let output = "";
      const proc = terminals.spawn({
        command: [process.execPath, "-e", "console.log('done')"],
        cwd: tmpdir(),
        env: process.env,
        cols: 80,
        rows: 24,
        onData: (bytes) => {
          output += new TextDecoder().decode(bytes);
        },
      });
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      expect(output).toContain("done");
    }
    expect(openDescriptors() - before).toBeLessThan(STARTS / 2);
  });
});
