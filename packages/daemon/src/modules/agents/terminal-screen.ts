import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { MouseEncoding } from "./mouse-encoding.ts";

/**
 * The session's screen on the daemon side (§4.4, ADR-26): a windowless terminal emulator fed the whole PTY output. A
 * session terminal in the UI that connects during the session (switching sessions, a refresh, a second window) first
 * gets the screen image from this emulator, and then further output. Without it it would have to replay the whole
 * output from the start, and Copilot CLI's TUI works on the alternate screen, which replaying the end of the buffer does not restore.
 *
 * The emulator processes writes asynchronously, so output reaches viewers only in the write callback: a viewer that
 * joined after the screen image gets exactly the chunks the image does not contain yet.
 */

const SCROLLBACK_LINES = 2000;

/** `@xterm/headless` is a CommonJS package; Node does not see its named exports, the default export works everywhere. */
const { Terminal } = headless;

export type ScreenViewer = (bytes: Uint8Array) => void;

export class TerminalScreen {
  readonly #terminal: InstanceType<typeof Terminal>;
  readonly #serializer = new SerializeAddon();
  readonly #viewers = new Set<ScreenViewer>();
  readonly #mouseEncoding: MouseEncoding;
  #revision = 0;

  constructor(cols: number, rows: number) {
    this.#terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.#terminal.loadAddon(this.#serializer);
    this.#mouseEncoding = new MouseEncoding(this.#terminal.parser);
  }

  get cols(): number {
    return this.#terminal.cols;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  /** Changes whenever the screen may have: after a processed write and after a resize. */
  get revision(): number {
    return this.#revision;
  }

  write(bytes: Uint8Array): void {
    this.#terminal.write(bytes, () => {
      this.#revision++;
      for (const viewer of this.#viewers) viewer(bytes);
    });
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
    this.#revision++;
  }

  /** The visible lines as plain text, top to bottom, as far as the emulator has processed the output (ADR-66). */
  lines(): string[] {
    const buffer = this.#terminal.buffer.active;
    return Array.from({ length: this.#terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
  }

  /**
   * Attaches a viewer: `onSnapshot` gets the screen image after all output so far has been processed, with the mouse
   * encoding the image itself leaves out (`MouseEncoding`), and the viewer every following chunk. Returns the detach function.
   */
  attach(viewer: ScreenViewer, onSnapshot: (snapshot: string) => void): () => void {
    let attached = true;
    this.#terminal.write("", () => {
      if (!attached) return;
      onSnapshot(this.#serializer.serialize() + this.#mouseEncoding.sequence());
      this.#viewers.add(viewer);
    });
    return () => {
      attached = false;
      this.#viewers.delete(viewer);
    };
  }

  dispose(): void {
    this.#viewers.clear();
    this.#terminal.dispose();
  }
}
