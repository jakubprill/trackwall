/**
 * The app's theme (ADR-235): dark, light, or the same as the system. A display preference of this computer, like the Home
 * scene's style, so it lives in `localStorage`, which every window of the desktop shell shares (one origin). Storage can be
 * missing, refuse access or hold a value from a newer version, so anything but a known choice reads as the default, and a
 * write that fails is forgotten. The default is dark, so an update does not turn the app light on a light desktop.
 */
const THEME_CHOICES = ["dark", "light", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The theme a page paints: a choice with "system" resolved. */
export type Theme = Exclude<ThemeChoice, "system">;

const DEFAULT_THEME_CHOICE: ThemeChoice = "dark";

/** The `localStorage` key; the `storage` event carries it to the other windows. */
export const THEME_KEY = "trackwall.theme";

/** The attribute on `<html>` that `index.css` reads, and on a dark island inside the light theme. */
export const THEME_ATTRIBUTE = "data-theme";

/**
 * Props of an element that stays dark in the light theme (a dark island): the session terminal, whose agent may paint
 * colours meant for a dark background, and Home's scene, whose glow adds light and vanishes on a light background.
 */
export const DARK_ISLAND = { [THEME_ATTRIBUTE]: "dark" } as const satisfies Record<typeof THEME_ATTRIBUTE, Theme>;

/** The media query that says the system asks for a light theme. */
export const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

function parseThemeChoice(value: string | null): ThemeChoice | undefined {
  return THEME_CHOICES.find((choice) => choice === value);
}

export function readThemeChoice(storage: () => Pick<Storage, "getItem">): ThemeChoice {
  try {
    return parseThemeChoice(storage().getItem(THEME_KEY)) ?? DEFAULT_THEME_CHOICE;
  } catch {
    return DEFAULT_THEME_CHOICE;
  }
}

export function saveThemeChoice(storage: () => Pick<Storage, "setItem">, choice: ThemeChoice): void {
  try {
    storage().setItem(THEME_KEY, choice);
  } catch {
    // The windows keep the theme until they close; only the next start does not remember it.
  }
}

export function resolveTheme(choice: ThemeChoice, systemPrefersLight: boolean): Theme {
  if (choice !== "system") return choice;
  return systemPrefersLight ? "light" : "dark";
}
