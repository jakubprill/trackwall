import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { formatBytes } from "./format.ts";

/**
 * App updates from GitHub Releases (ADR-53), done by the Tauri shell: `check_update` asks for the latest release,
 * `install_update` downloads it, checks its signature, installs it and restarts the app. Names and shapes are also in
 * `apps/desktop/src-tauri/src/updates.rs` (`apps/desktop/test/shell-events.test.ts` compares them). Only in the Tauri
 * window; in the browser the app is updated by hand.
 */
export const UpdateCheck = z.object({ currentVersion: z.string(), available: z.string().nullable() });
type UpdateCheck = z.infer<typeof UpdateCheck>;

const PROGRESS_EVENT = "update-progress";
const UpdateProgress = z.object({ downloaded: z.number(), total: z.number().nullable() });
type UpdateProgress = z.infer<typeof UpdateProgress>;

/** The restart stops the daemon, so the user decides when to install. */
const RESTART_WARNING = "Restarting stops running services and sessions.";

export async function checkUpdate(): Promise<UpdateCheck> {
  return UpdateCheck.parse(await invoke<unknown>("check_update"));
}

/** Rejects when the update failed. Success resolves while the app is already restarting. */
export async function installUpdate(version: string): Promise<void> {
  await invoke("install_update", { version });
}

/** Calls `onProgress` as the download goes; the returned function stops listening. */
export function listenToUpdateProgress(onProgress: (progress: UpdateProgress) => void): () => void {
  const unlisten = listen<unknown>(PROGRESS_EVENT, (event) => {
    const progress = UpdateProgress.safeParse(event.payload);
    if (progress.success) onProgress(progress.data);
  });
  return () => void unlisten.then((stop) => stop());
}

export type AppUpdate =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "latest"; currentVersion: string }
  | { state: "available"; currentVersion: string; version: string }
  | { state: "check-failed"; message: string }
  | { state: "installing"; version: string; progress?: UpdateProgress }
  | { state: "install-failed"; version: string; message: string };

export type UpdateEvent =
  | { kind: "check-started" }
  | { kind: "checked"; result: UpdateCheck }
  | { kind: "check-failed"; message: string }
  | { kind: "install-started"; version: string }
  | { kind: "progress"; progress: UpdateProgress }
  | { kind: "install-failed"; message: string };

/**
 * The next update state. A check changes nothing while an install runs, and does not take back an update already
 * found: the strip with "Update and restart" stays through the next periodic check, even one that fails offline.
 */
export function nextUpdate(update: AppUpdate, event: UpdateEvent): AppUpdate {
  const keep = update.state === "installing" || update.state === "available";
  switch (event.kind) {
    case "check-started":
      return keep ? update : { state: "checking" };
    case "checked":
      if (update.state === "installing") return update;
      return event.result.available
        ? { state: "available", currentVersion: event.result.currentVersion, version: event.result.available }
        : { state: "latest", currentVersion: event.result.currentVersion };
    case "check-failed":
      return keep ? update : { state: "check-failed", message: event.message };
    case "install-started":
      return { state: "installing", version: event.version };
    case "progress":
      return update.state === "installing" ? { ...update, progress: event.progress } : update;
    case "install-failed":
      return update.state === "installing" ? { state: "install-failed", version: update.version, message: event.message } : update;
  }
}

/** "Trackwall 0.3.1 is available (you have 0.3.0). Restarting stops…" */
export function availableText(update: { currentVersion: string; version: string }): string {
  return `Trackwall ${update.version} is available (you have ${update.currentVersion}). ${RESTART_WARNING}`;
}

/** "Installing Trackwall 0.3.1: 12.0 MB of 40.0 MB (30%)", or with "…" before the first progress. */
export function installingText(update: { version: string; progress?: UpdateProgress }): string {
  return `Installing Trackwall ${update.version}${update.progress ? `: ${progressLabel(update.progress)}` : "…"}`;
}

/** "12.0 MB of 40.0 MB (30%)", or only the downloaded size when the server did not send the total. */
export function progressLabel({ downloaded, total }: UpdateProgress): string {
  if (!total) return formatBytes(downloaded);
  return `${formatBytes(downloaded)} of ${formatBytes(total)} (${Math.floor((downloaded / total) * 100)}%)`;
}
