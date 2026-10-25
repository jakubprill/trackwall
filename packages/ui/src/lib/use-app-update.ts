import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { isMainWindow } from "./app-window.ts";
import { type AppUpdate, checkUpdate, installUpdate, listenToUpdateProgress, nextUpdate } from "./updates.ts";

/** The first check waits for the app to settle; then once in a while, because the app runs for days in the tray. */
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface AppUpdateHandle {
  update: AppUpdate;
  check: () => void;
  install: (version: string) => void;
  /** The version the user put off with "Later"; the strip comes back for a newer one or after a restart. */
  dismissed?: string;
  dismiss: (version: string) => void;
}

/**
 * Update state of the app (ADR-53), one per window: the main window checks on its own, every window checks when asked
 * ("Settings > Updates") and installs on request (`nextUpdate` has the rules). `undefined` outside the Tauri window,
 * where there is no shell to update.
 */
export function useAppUpdate(): AppUpdateHandle | undefined {
  const [update, dispatch] = useReducer(nextUpdate, { state: "idle" });
  const [dismissed, dismiss] = useState<string>();
  const installing = useRef(false);
  const tauri = isTauri();

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
    dispatch({ kind: "install-started", version });
    const stop = listenToUpdateProgress((progress) => dispatch({ kind: "progress", progress }));
    installUpdate(version)
      .catch((err: unknown) => dispatch({ kind: "install-failed", message: errorMessage(err) }))
      .finally(() => {
        stop();
        installing.current = false;
      });
  }, []);

  useEffect(() => {
    // One periodic check per app, not per window (ADR-49).
    if (!isMainWindow()) return;
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [tauri, check]);

  return tauri ? { update, check, install, dismissed, dismiss } : undefined;
}
