import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { formatBytes } from "./format.ts";

/**
 * App updates from GitHub Releases (ADR-53), done by the Tauri shell: `check_update` asks for the latest release,
 * `install_update` downloads it, checks its signature, installs it and restarts the app. Names and shapes are also in
 * `apps/desktop/src-tauri/src/updates.rs`. Only in the Tauri window; in the browser the app is updated by hand.
 */
export const UpdateCheck = z.object({ currentVersion: z.string(), available: z.string().nullable() });
export type UpdateCheck = z.infer<typeof UpdateCheck>;

/** The restart stops the daemon, so the user decides when to install. */
export const RESTART_WARNING = "Restarting stops running services and sessions.";

const PROGRESS_EVENT = "update-progress";
export const UpdateProgress = z.object({ downloaded: z.number(), total: z.number().nullable() });
export type UpdateProgress = z.infer<typeof UpdateProgress>;

export async function checkUpdate(): Promise<UpdateCheck> {
  return UpdateCheck.parse(await invoke<unknown>("check_update"));
}

/** Resolves only when the update failed: after success the app restarts. */
export async function installUpdate(): Promise<void> {
  await invoke("install_update");
}

/** Calls `onProgress` for every downloaded chunk; the returned function stops listening. */
export function listenToUpdateProgress(onProgress: (progress: UpdateProgress) => void): () => void {
  const unlisten = listen<unknown>(PROGRESS_EVENT, (event) => {
    const progress = UpdateProgress.safeParse(event.payload);
    if (progress.success) onProgress(progress.data);
  });
  return () => void unlisten.then((stop) => stop());
}

/** "12.0 MB of 40.0 MB (30%)", or only the downloaded size when the server did not send the total. */
export function progressLabel({ downloaded, total }: UpdateProgress): string {
  if (!total) return formatBytes(downloaded);
  return `${formatBytes(downloaded)} of ${formatBytes(total)} (${Math.floor((downloaded / total) * 100)}%)`;
}
