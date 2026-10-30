import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/**
 * The dev container the desktop app starts itself (ADR-139): the folder on this computer with its configuration and the
 * folder inside it that VS Code opens. "Start" opens VS Code on it like the user's own shortcut, reads the daemon's token
 * from the container and switches the app to that daemon. The commands are in
 * `apps/desktop/src-tauri/src/dev_container.rs`. Tauri window only.
 */
const GET_COMMAND = "dev_container";
const SET_COMMAND = "set_dev_container";
const START_COMMAND = "start_dev_container";

export const DevContainer = z.object({ folder: z.string(), open: z.string() });
export type DevContainer = z.infer<typeof DevContainer>;

/** The folder the configuration's own example opens (`workspaceFolder` in the dev container guide). */
export const DEFAULT_FOLDER_TO_OPEN = "/workspaces";

/** The saved dev container, or `null` when none is set. */
export async function savedDevContainer(): Promise<DevContainer | null> {
  return DevContainer.nullable().parse(await invoke<unknown>(GET_COMMAND));
}

/** Saves the dev container, whose folder must hold a dev container configuration; `null` forgets it. */
export function setDevContainer(dev: DevContainer | null): Promise<void> {
  return invoke(SET_COMMAND, { dev });
}

/** Starts the container, or finds it running, and switches the app to Trackwall in it; the app restarts. */
export function startDevContainer(): Promise<void> {
  return invoke(START_COMMAND);
}
