import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { inDesktopShell, isMainWindow } from "./app-window.ts";
import { type AppUpdate, cancelUpdate, checkUpdate, dueAfterTurns, installUpdate, listenToUpdateProgress, nextUpdate } from "./updates.ts";

/** The first check waits for the app to settle; then once in a while, because the app runs for days in the tray. */
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface AppUpdateHandle {
  update: AppUpdate;
  check: () => void;
  install: (version: string) => void;
  cancel: () => void;
  /** Agents in the middle of a turn now; `undefined` until the session list has loaded. */
  agentsInTurn: number | undefined;
  /** Install once no agent is in the middle of a turn (ADR-97), and `cancelWaiting` takes that back. */
  waitForTurns: () => void;
  cancelWaiting: () => void;
  /** The version the user put off with "Later"; the strip comes back for a newer one or after a restart. */
  dismissed?: string;
  dismiss: (version: string) => void;
}

/**
 * Update state of the app (ADR-53), one per window: the main window checks on its own, every window checks when asked
 * ("Settings > Updates") and installs on request (`nextUpdate` has the rules). `undefined` outside the Tauri window,
 * where there is no shell to update. `agentsInTurn` is the count from the session list, which a waiting update follows.
 */
export function useAppUpdate(agentsInTurn: number | undefined): AppUpdateHandle | undefined {
  const [update, dispatch] = useReducer(nextUpdate, { state: "idle" });
  const [dismissed, dismiss] = useState<string>();
  const installing = useRef(false);
  const tauri = inDesktopShell();

  const check = useCallback(() => {
    dispatch({ kind: "check-started" });
    checkUpdate().then(
      (result) => dispatch({ kind: "checked", result }),
      (err: unknown) => dispatch({ kind: "check-failed", message: errorMessage(err) }),
    );
  }, []);

  // A second click before the next render would get the shell's "already being installed" as a failure of the first.
  const install = useCallback((version: string) => {
    if (installing.current) return;
    installing.current = true;
    dispatch({ kind: "install-started", version, at: Date.now() });
    const stop = listenToUpdateProgress((progress) => dispatch({ kind: "progress", progress, at: Date.now() }));
    installUpdate(version)
      .catch((err: unknown) => dispatch({ kind: "install-failed", message: errorMessage(err) }))
      .finally(() => {
        stop();
        installing.current = false;
      });
  }, []);

  // A failed cancel leaves the install running, which the view keeps showing; there is nothing more to tell.
  const cancel = useCallback(() => void cancelUpdate().catch(() => {}), []);

  const waitForTurns = useCallback(() => dispatch({ kind: "wait-started" }), []);
  const cancelWaiting = useCallback(() => dispatch({ kind: "wait-cancelled" }), []);
  // The last turn ended: the update the user put off until then installs now.
  const due = dueAfterTurns(update, agentsInTurn);
  useEffect(() => {
    if (due !== undefined) install(due);
  }, [due, install]);

  useEffect(() => {
    // One periodic check per app, not per window (ADR-49).
    if (!isMainWindow()) return;
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [check]);

  return tauri ? { update, check, install, cancel, agentsInTurn, waitForTurns, cancelWaiting, dismissed, dismiss } : undefined;
}
