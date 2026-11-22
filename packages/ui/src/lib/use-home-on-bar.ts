import { useCallback, useEffect, useState } from "react";
import { HOME_ON_BAR_KEY, type HomeOnBar, readHomeOnBar, saveHomeOnBar } from "./home-on-bar.ts";

const storage = () => window.localStorage;

/** Whether the view bar shows Home, and the choice that changes it (Settings › App › Home). */
export interface HomeOnBarChoice {
  value: HomeOnBar;
  choose: (value: HomeOnBar) => void;
}

/**
 * Whether this window's view bar shows Home (ADR-294), and the choice from Settings › App. A choice made in another
 * window of the desktop shell arrives with the `storage` event, so every window's bar follows it at once.
 */
export function useHomeOnBar(): HomeOnBarChoice {
  const [value, setValue] = useState(() => readHomeOnBar(storage));
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      // `null`: another window cleared the whole storage.
      if (event.key === HOME_ON_BAR_KEY || event.key === null) setValue(readHomeOnBar(storage));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const choose = useCallback((next: HomeOnBar) => {
    setValue(next);
    saveHomeOnBar(storage, next);
  }, []);
  return { value, choose };
}
