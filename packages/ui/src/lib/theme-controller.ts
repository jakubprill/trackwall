import { invoke } from "@tauri-apps/api/core";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { inDesktopShell } from "./app-window.ts";
import {
  readThemeChoice,
  resolveTheme,
  SYSTEM_LIGHT_QUERY,
  saveThemeChoice,
  THEME_ATTRIBUTE,
  THEME_KEY,
  type Theme,
  type ThemeChoice,
} from "./theme.ts";

/**
 * Keeps a window's page in the chosen theme (ADR-235): sets `data-theme` on `<html>` before the first paint (`main.tsx`
 * starts it before React), follows the system while the choice is "system", and takes a choice made in another window
 * from the `storage` event. The desktop shell gets every choice too, so its windows' title bars, Mica and vibrancy
 * follow, and so that the web view reports the system's scheme to the page while the choice is "system"
 * (`apps/desktop/src-tauri/src/theme.rs`).
 */
export interface ThemeEnvironment {
  storage: () => Pick<Storage, "getItem" | "setItem">;
  /** `matchMedia(SYSTEM_LIGHT_QUERY)`. */
  systemLight: Pick<MediaQueryList, "matches" | "addEventListener">;
  /** Calls `listener` with the key of every `storage` event, a change another window made. */
  onStorage: (listener: (key: string | null) => void) => void;
  root: Pick<Element, "setAttribute">;
  /** Tells the desktop shell the choice; absent outside the shell. */
  tellShell?: (choice: ThemeChoice) => Promise<void>;
}

export class ThemeController {
  #choice: ThemeChoice;
  #theme: Theme;
  readonly #environment: ThemeEnvironment;
  readonly #listeners = new Set<() => void>();

  constructor(environment: ThemeEnvironment) {
    this.#environment = environment;
    this.#choice = readThemeChoice(environment.storage);
    this.#theme = this.#resolve();
    environment.root.setAttribute(THEME_ATTRIBUTE, this.#theme);
    environment.systemLight.addEventListener("change", () => this.#repaint());
    environment.onStorage((key) => {
      if (key !== THEME_KEY && key !== null) return;
      this.#choice = readThemeChoice(environment.storage);
      this.#repaint();
    });
    this.#tellShell();
  }

  get choice(): ThemeChoice {
    return this.#choice;
  }

  get theme(): Theme {
    return this.#theme;
  }

  choose(choice: ThemeChoice): void {
    this.#choice = choice;
    saveThemeChoice(this.#environment.storage, choice);
    this.#repaint();
    this.#tellShell();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #resolve(): Theme {
    return resolveTheme(this.#choice, this.#environment.systemLight.matches);
  }

  #repaint(): void {
    this.#theme = this.#resolve();
    this.#environment.root.setAttribute(THEME_ATTRIBUTE, this.#theme);
    for (const listener of this.#listeners) listener();
  }

  #tellShell(): void {
    // The page is in its theme already; a shell that does not take it only leaves the title bar as it was.
    this.#environment.tellShell?.(this.#choice).catch((err: unknown) => console.error("telling the shell the theme:", err));
  }
}

/** The shell command that gives every window the theme (`theme.rs`). */
const SET_THEME_COMMAND = "set_theme";

/** The controller of this window's page. */
export function startTheme(): ThemeController {
  return new ThemeController({
    storage: () => window.localStorage,
    systemLight: window.matchMedia(SYSTEM_LIGHT_QUERY),
    onStorage: (listener) => window.addEventListener("storage", (event) => listener(event.key)),
    root: document.documentElement,
    tellShell: inDesktopShell() ? (choice) => invoke(SET_THEME_COMMAND, { choice }) : undefined,
  });
}

export const ThemeContext = createContext<ThemeController | null>(null);

/** The theme this page paints and the choice behind it; without a controller (a component test) the default dark. */
export function useTheme(): { theme: Theme; choice: ThemeChoice; choose: (choice: ThemeChoice) => void } {
  const controller = useContext(ThemeContext);
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller]);
  const theme = useSyncExternalStore(subscribe, () => controller?.theme ?? "dark");
  const choice = useSyncExternalStore(subscribe, () => controller?.choice ?? "dark");
  return { theme, choice, choose: (next) => controller?.choose(next) };
}
