import { useEffect, useState } from "react";

/**
 * Whether the End task question of a task without a session is open in its tile or row. The X only opens it and its
 * Cancel closes it, because Cancel is locked while the removal runs and a closed question would hide a refusal or an
 * error. A session that appears meanwhile (Resume) closes it, so that it does not come back by itself when that session
 * is closed later.
 */
export function useTaskEnding(sessionless: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!sessionless) setOpen(false);
  }, [sessionless]);
  return { open: open && sessionless, show: () => setOpen(true), hide: () => setOpen(false) };
}
