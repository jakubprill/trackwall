/**
 * The screen of a session window in the daemon's session tests and the contract tests, as Copilot CLI (or the fake)
 * drew it in the reference's size: the window's output put through the emulator once it has processed all of it.
 */
import { promptBoxOnScreen } from "../../src/modules/agents/copilot-prompt-box.ts";
import { TerminalScreen } from "../../src/modules/agents/terminal-screen.ts";
import type { viewer } from "./agents.ts";
import { REFERENCE_COLS, REFERENCE_ROWS } from "./copilot-reference.ts";

type Window = ReturnType<typeof viewer>;

/** The window's screen as Copilot CLI drew it in the reference's size, once the emulator has processed all output. */
export async function screenLines(window: Window): Promise<string[]> {
  const screen = new TerminalScreen(REFERENCE_COLS, REFERENCE_ROWS);
  try {
    screen.write(new TextEncoder().encode(window.text()));
    await new Promise<void>((resolve) =>
      screen.attach(
        () => {},
        () => resolve(),
      ),
    );
    return screen.lines().map((l) => l.trimEnd());
  } finally {
    screen.dispose();
  }
}

/**
 * Waits until the window's screen ends with Copilot CLI's input box, empty or with text in it: after `agentStop` it
 * draws the box again only a moment later, and keys typed before that are lost (ADR-68).
 */
export async function untilInputBox(window: Window, box: "empty" | "text", timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (promptBoxOnScreen(await screenLines(window)) !== box) {
    if (Date.now() > until) throw new Error(`gave up waiting for the input box (${box}):\n${(await screenLines(window)).join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
