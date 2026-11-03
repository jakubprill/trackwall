// Which slide of the talk to show (talk-deck.ts): moving one slide at a time, and the slide a link names.

/** The slide one step from `index` in `direction`; the first and the last stay where they are. */
export function stepSlide(index: number, count: number, direction: 1 | -1): number {
  return Math.min(count - 1, Math.max(0, index + direction));
}

/** The slide a link's hash names as its number from 1 (`#3` is the third), or the first when it names none. */
export function slideFromHash(hash: string, count: number): number {
  const number = Number(hash.replace(/^#/, ""));
  return Number.isInteger(number) && number >= 1 && number <= count ? number - 1 : 0;
}

/** The hash that names a slide, so a link or a reload opens the talk on it. */
export function hashOfSlide(index: number): string {
  return `#${index + 1}`;
}
