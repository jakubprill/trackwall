/**
 * The screen of a session window in the contract tests, as Copilot CLI drew it in the reference's size: the window's
 * output put through the emulator once it has processed all of it.
 */
import { TerminalScreen } from "../../src/modules/agents/terminal-screen.ts";
import type { viewer } from "../../test/support/agents.ts";
import { REFERENCE_COLS, REFERENCE_ROWS } from "../../test/support/copilot-reference.ts";

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
