import { createContext } from "react";

/**
 * The keyboard is in another part of the window than these session terminals, so the one selected among them is not
 * the one in front of the user (ADR-47) and does not take the keyboard. `App` sets it around the views while the
 * keyboard is in the supervisor panel (ADR-58), and to `false` around the panel itself.
 */
export const KeyboardElsewhere = createContext(false);

/**
 * Marks a part of the window, the supervisor panel (ADR-58), that reports the keyboard coming into it. A session
 * screen in it takes the keyboard when the part gets it from outside (Alt+0), but not when the user already put the
 * keyboard on something in it (Tab or a click on a button or an approval's option), which would otherwise jump to
 * the message box or the terminal.
 */
export const KEYBOARD_REGION = "data-keyboard-region";

/** What `keyboardInRegion` needs of an element: the region around it, and whether a region holds the focused element. */
export interface RegionMember<Focused> {
  closest(selector: string): { contains(node: Focused | null): boolean } | null;
}

/** Whether the focused element is already in the keyboard region around `target`; never outside such a region. */
export function keyboardInRegion<Focused>(target: RegionMember<Focused>, focused: Focused | null): boolean {
  if (focused === null) return false;
  return target.closest(`[${KEYBOARD_REGION}]`)?.contains(focused) ?? false;
}
