import { createContext } from "react";

/**
 * The keyboard is in another part of the window than these session terminals, so the one selected among them is not
 * the one in front of the user (ADR-47) and does not take the keyboard. `App` sets it around the views while the
 * keyboard is in the supervisor panel (ADR-58), and to `false` around the panel itself.
 */
export const KeyboardElsewhere = createContext(false);
