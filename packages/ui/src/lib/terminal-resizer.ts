/**
 * Dopasowanie okna terminala sesji do kontenera (§4.4, ADR-26). Zmiana rozmiaru okna daje serię zdarzeń
 * `ResizeObserver`; dopasowanie na każde z nich przeplatało się z układem strony (pojawiające się i znikające paski
 * przewijania zmieniają szerokość, a nowa liczba kolumn znowu układ), więc terminal skakał. Tu dopasowanie idzie
 * najwyżej raz na klatkę, a terminal i sesja dostają nowy rozmiar tylko wtedy, gdy liczba kolumn albo wierszy jest
 * inna niż ostatnio.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalResizerOptions {
  /** Rozmiar, który zmieści się w kontenerze; `undefined`, gdy kontener nie ma jeszcze wymiarów. */
  measure: () => TerminalSize | undefined;
  /** Zmiana rozmiaru terminala w oknie i PTY sesji. */
  apply: (size: TerminalSize) => void;
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

export function terminalResizer(o: TerminalResizerOptions & { initial: TerminalSize }) {
  let last = o.initial;
  let pending: number | undefined;
  return {
    /** Prośba o dopasowanie; kolejne prośby przed następną klatką łączą się w jedną. */
    request(): void {
      if (pending !== undefined) return;
      pending = o.schedule(() => {
        pending = undefined;
        const size = o.measure();
        if (!size || (size.cols === last.cols && size.rows === last.rows)) return;
        last = size;
        o.apply(size);
      });
    },
    dispose(): void {
      if (pending !== undefined) o.cancel(pending);
      pending = undefined;
    },
  };
}
