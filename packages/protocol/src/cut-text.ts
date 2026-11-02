/**
 * Text cut to `max` UTF-16 units with "…" at the end, never between the two halves of a character outside the BMP (an
 * emoji), so a cut text still fits a limit the daemon checks with `.max()`.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept}…`;
}
