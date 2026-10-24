import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { checkUpdate, installUpdate, listenToUpdateProgress, type UpdateProgress } from "./updates.ts";

/** The first check waits for the app to settle; then once in a while, because the app runs for days in the tray. */
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type AppUpdate =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "latest"; currentVersion: string }
  | { state: "available"; currentVersion: string; version: string }
  | { state: "installing"; version: string; progress?: UpdateProgress }
  /** `version` is set when the install failed, so that it can be tried again. */
  | { state: "failed"; message: string; version?: string };

export interface AppUpdateHandle {
  update: AppUpdate;
  check: () => void;
  install: (version: string) => void;
}

/**
 * Update state of the app (ADR-53), one per window: checks on its own and installs on request.
 * `undefined` outside the Tauri window, where there is no shell to update.
 */
export function useAppUpdate(): AppUpdateHandle | undefined {
  const [update, setUpdate] = useState<AppUpdate>({ state: "idle" });
  const installing = useRef(false);
  const tauri = isTauri();

  const check = useCallback(() => {
    if (installing.current) return;
    setUpdate({ state: "checking" });
    checkUpdate().then(
      (result) => {
        if (installing.current) return;
        setUpdate(
          result.available
            ? { state: "available", currentVersion: result.currentVersion, version: result.available }
            : { state: "latest", currentVersion: result.currentVersion },
        );
      },
      (err: unknown) => {
        if (!installing.current) setUpdate({ state: "failed", message: errorMessage(err) });
      },
    );
  }, []);

  const install = useCallback((version: string) => {
    if (installing.current) return;
    installing.current = true;
    setUpdate({ state: "installing", version });
    const stop = listenToUpdateProgress((progress) => setUpdate({ state: "installing", version, progress }));
    // Success ends in a restart, so only a failure comes back here.
    installUpdate()
      .catch((err: unknown) => setUpdate({ state: "failed", message: errorMessage(err), version }))
      .finally(() => {
        stop();
        installing.current = false;
      });
  }, []);

  useEffect(() => {
    if (!tauri) return;
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [tauri, check]);

  return tauri ? { update, check, install } : undefined;
}
