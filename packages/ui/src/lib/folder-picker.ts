import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/**
 * Opens the system folder picker for the projects folder at `start` (empty: the system's choice) and returns the
 * chosen full path, or `undefined` when the user closed it. Tauri window only (ADR-51); the command and its arguments
 * are `pick_projects_folder` in `apps/desktop/src-tauri/src/folder_picker.rs`.
 */
const PICK_COMMAND = "pick_projects_folder";

export async function pickFolder(start: string): Promise<string | undefined> {
  return (
    z
      .string()
      .nullable()
      .parse(await invoke<unknown>(PICK_COMMAND, { start })) ?? undefined
  );
}
