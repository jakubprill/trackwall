import { describe, expect, test } from "bun:test";
import { TerminalScreen } from "../src/modules/agents/terminal-screen.ts";

function snapshotAfter(output: string): Promise<string> {
  const screen = new TerminalScreen(80, 24);
  screen.write(new TextEncoder().encode(output));
  return new Promise<string>((resolve) => {
    screen.attach(
      () => {},
      (snapshot) => {
        screen.dispose();
        resolve(snapshot);
      },
    );
  });
}

describe("the screen image a session window gets when it connects", () => {
  test("keeps the SGR mouse encoding Copilot CLI turns on, so the wheel and clicks still reach it", async () => {
    const snapshot = await snapshotAfter("\x1b[?1049h\x1b[?1003h\x1b[?1006hhello");
    expect(snapshot).toContain("\x1b[?1003h");
    expect(snapshot.endsWith("\x1b[?1006h")).toBe(true);
  });

  test("keeps the encoding when it is set together with the tracking mode in one sequence", async () => {
    expect((await snapshotAfter("\x1b[?1003;1006h")).endsWith("\x1b[?1006h")).toBe(true);
  });

  test("has no mouse encoding once the program resets it", async () => {
    expect(await snapshotAfter("\x1b[?1003h\x1b[?1006h\x1b[?1006l")).not.toContain("\x1b[?1006h");
  });

  test("keeps SGR in pixels when it replaces SGR", async () => {
    const snapshot = await snapshotAfter("\x1b[?1006h\x1b[?1016h");
    expect(snapshot.endsWith("\x1b[?1016h")).toBe(true);
    expect(snapshot).not.toContain("\x1b[?1006h");
  });

  test("has no mouse encoding once SGR is reset, whichever SGR mode was on", async () => {
    expect(await snapshotAfter("\x1b[?1016h\x1b[?1006l")).not.toContain("\x1b[?1016h");
  });

  test("keeps SGR when the program asks for an encoding xterm.js does not support", async () => {
    expect((await snapshotAfter("\x1b[?1006h\x1b[?1015h\x1b[?1005h")).endsWith("\x1b[?1006h")).toBe(true);
  });

  test("has no mouse encoding after a terminal reset", async () => {
    expect(await snapshotAfter("\x1b[?1006h\x1bc")).not.toContain("\x1b[?1006h");
  });

  test("has no mouse encoding when the program never set one", async () => {
    const snapshot = await snapshotAfter("\x1b[?1049hhello");
    expect(snapshot).not.toContain("\x1b[?1006h");
    expect(snapshot).not.toContain("\x1b[?1016h");
  });
});
