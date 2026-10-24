import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod";

/** Only the Tauri window has the system folder picker (ADR-51); the page opened from the daemon has a text field only. */
export const canPickFolder = isTauri;

/**
 * Opens the system folder picker at `start` and returns the chosen full path, or `undefined` when the user closed it.
 * The command and its arguments are `pick_folder` in `apps/desktop/src-tauri/src/folder_picker.rs`.
 */
export async function pickFolder(start: string): Promise<string | undefined> {
  return (
    z
      .string()
      .nullable()
      .parse(await invoke<unknown>("pick_folder", { start })) ?? undefined
  );
}
