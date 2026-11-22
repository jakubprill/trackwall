import { useCallback, useEffect, useState } from "react";
import { readSeenWhatsNew, saveAllWhatsNewSeen, WHATS_NEW, WHATS_NEW_SEEN_KEY, type WhatsNewEntry, whatsNewEntries } from "./whats-new.ts";

const storage = () => window.localStorage;

const ALL_SEEN: ReadonlySet<string> = new Set(WHATS_NEW.map((entry) => entry.id));

/**
 * The entries of What's new this window lists (ADR-296), and "Dismiss". A new computer counts every entry as seen at
 * once, so that the strip does not come later, as soon as the user sets the projects folder. "Dismiss" in another window
 * arrives with the `storage` event.
 */
export function useWhatsNew(newComputer: boolean | undefined): {
  entries: readonly WhatsNewEntry[] | undefined;
  dismiss: () => void;
} {
  const [seen, setSeen] = useState(() => readSeenWhatsNew(storage));
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      // `null`: another window cleared the whole storage.
      if (event.key === WHATS_NEW_SEEN_KEY || event.key === null) setSeen(readSeenWhatsNew(storage));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const dismiss = useCallback(() => {
    saveAllWhatsNewSeen(storage);
    setSeen(ALL_SEEN);
  }, []);
  useEffect(() => {
    if (seen === null && newComputer === true) dismiss();
  }, [seen, newComputer, dismiss]);
  return { entries: whatsNewEntries(seen, newComputer), dismiss };
}
