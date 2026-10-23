import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";

/**
 * Ekran sesji po stronie daemona (§4.4, ADR-25): emulator terminala bez okna, karmiony całym wyjściem PTY.
 * Okno terminala w UI, które podłącza się w trakcie sesji (przełączenie sesji, odświeżenie, drugie okno), dostaje
 * najpierw obraz ekranu z tego emulatora, a potem dalsze wyjście. Bez tego musiałoby odtworzyć całe wyjście od
 * startu, a TUI Copilot CLI pracuje na alternatywnym ekranie, którego koniec bufora nie odtwarza.
 *
 * Emulator przetwarza zapis asynchronicznie, więc wyjście trafia do widzów dopiero w wywołaniu zwrotnym zapisu:
 * widz dołączony po obrazie ekranu dostaje dokładnie te kawałki, których obraz jeszcze nie zawiera.
 */

const SCROLLBACK_LINES = 2000;

/** `@xterm/headless` to paczka CommonJS; Node nie widzi jej nazwanych eksportów, domyślny eksport działa wszędzie. */
const { Terminal } = headless;

export type ScreenViewer = (bytes: Uint8Array) => void;

export class TerminalScreen {
  readonly #terminal: InstanceType<typeof Terminal>;
  readonly #serializer = new SerializeAddon();
  readonly #viewers = new Set<ScreenViewer>();

  constructor(cols: number, rows: number) {
    this.#terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.#terminal.loadAddon(this.#serializer);
  }

  get cols(): number {
    return this.#terminal.cols;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  write(bytes: Uint8Array): void {
    this.#terminal.write(bytes, () => {
      for (const viewer of this.#viewers) viewer(bytes);
    });
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
  }

  /**
   * Dołącza widza: `onSnapshot` dostaje obraz ekranu po przetworzeniu całego dotychczasowego wyjścia, a widz każdy
   * następny kawałek. Zwraca odłączenie.
   */
  attach(viewer: ScreenViewer, onSnapshot: (snapshot: string) => void): () => void {
    let attached = true;
    this.#terminal.write("", () => {
      if (!attached) return;
      onSnapshot(this.#serializer.serialize());
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
