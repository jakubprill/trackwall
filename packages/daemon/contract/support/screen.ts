/**
 * The text a session terminal shows, rendered from the terminal's output by the same terminal emulator the daemon uses
 * for the session screen. The raw output is not enough on Windows: ConPTY redraws only changed cells and replaces runs
 * of blanks with cursor moves, so a phrase can be split by sequences that leave no spaces once stripped.
 */
import headless from "@xterm/headless";
import { INITIAL_COLS, INITIAL_ROWS } from "../../src/modules/agents/agents.ts";

const { Terminal } = headless;

/** The visible lines of the screen after `output`, at the session's PTY size (no session terminal resized it). */
export async function screenText(output: string): Promise<string> {
  const terminal = new Terminal({ cols: INITIAL_COLS, rows: INITIAL_ROWS, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(output, resolve));
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < terminal.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  terminal.dispose();
  return lines.join("\n");
}

/** Waits until the rendered screen shows `text`; the error carries the last screen. */
export async function waitForScreen(output: () => string, text: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const screen = await screenText(output());
    if (screen.includes(text)) return;
    if (Date.now() > until) throw new Error(`the screen never showed "${text}"; last screen:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
