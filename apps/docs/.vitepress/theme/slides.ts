// Which slide of the talk to show (talk-deck.ts): the keys that move between slides, moving one slide at a time,
// and the slide a link names.

/** The keys a presenter's clicker sends (Page Up and Down) and the ones a keyboard offers; Up, Down and Space keep scrolling a long slide. */
const NEXT_KEYS = ["arrowright", "pagedown", "j"];
const PREVIOUS_KEYS = ["arrowleft", "pageup", "k"];

/** The direction a key moves the deck in, or undefined when the key is not one of the deck's; J and K also with Shift or Caps Lock. */
export function slideKeyDirection(key: string): 1 | -1 | undefined {
  const name = key.toLowerCase();
  if (NEXT_KEYS.includes(name)) return 1;
  if (PREVIOUS_KEYS.includes(name)) return -1;
  return undefined;
}

/** Whether a key goes to the element that has the focus, a field the reader types into, rather than to the deck. */
export function isTypingInto(focused: { tagName: string; isContentEditable: boolean } | null): boolean {
  return focused !== null && (focused.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName));
}

/** The slide one step from `index` in `direction`; the first and the last stay where they are. */
export function stepSlide(index: number, count: number, direction: 1 | -1): number {
  return Math.min(count - 1, Math.max(0, index + direction));
}

/** The slide a hash names by its number from 1 (`#3` is the third), or undefined when it names none, as a heading's hash. */
export function slideFromHash(hash: string, count: number): number | undefined {
  const number = Number(hash.replace(/^#/, ""));
  return hash.length > 1 && Number.isInteger(number) && number >= 1 && number <= count ? number - 1 : undefined;
}

/** The hash that names a slide, so a link or a reload opens the talk on it. */
export function hashOfSlide(index: number): string {
  return `#${index + 1}`;
}
