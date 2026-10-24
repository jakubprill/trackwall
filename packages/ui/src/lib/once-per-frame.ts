/**
 * Łączy serię wywołań przed następną klatką w jedno. Zmiana rozmiaru okna daje serię zdarzeń `ResizeObserver`,
 * a dopasowanie terminala sesji na każde z nich przeplatało się z układem strony, więc terminal skakał (ADR-26).
 */
export function oncePerFrame(
  callback: () => void,
  schedule: (frame: () => void) => number = requestAnimationFrame,
  cancel: (handle: number) => void = cancelAnimationFrame,
) {
  let pending: number | undefined;
  return {
    request(): void {
      if (pending !== undefined) return;
      pending = schedule(() => {
        pending = undefined;
        callback();
      });
    },
    dispose(): void {
      if (pending !== undefined) cancel(pending);
      pending = undefined;
    },
  };
}
