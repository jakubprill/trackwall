// Moving between the slides of the talk with the keyboard (talk-keys.ts): which slide a key press goes to.

/** How far above the top of the window a slide may start and still count as the one being shown, in pixels. */
const SHOWN_TOLERANCE = 8;

/**
 * The index of the slide to scroll to, from where each slide starts on the page (in order), the window's scroll
 * position and the direction. Back from the middle of a slide goes to its start; the first slide comes from above
 * the first one, and the last one stays the last.
 */
export function slideToShow(slideTops: number[], scrollTop: number, direction: 1 | -1): number | undefined {
  if (slideTops.length === 0) return undefined;
  const shown = slideTops.findLastIndex((top) => top <= scrollTop + SHOWN_TOLERANCE);
  if (shown === -1) return direction === 1 ? 0 : undefined;
  const intoShown = scrollTop > (slideTops[shown] ?? scrollTop) + SHOWN_TOLERANCE;
  if (direction === -1 && intoShown) return shown;
  return Math.min(slideTops.length - 1, Math.max(0, shown + direction));
}
