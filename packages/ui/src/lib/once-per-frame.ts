/**
 * Merges a series of calls before the next frame into one. Resizing the window gives a series of `ResizeObserver`
 * events, and fitting the session terminal on each of them interleaved with the page layout, so the terminal jumped (ADR-26).
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
