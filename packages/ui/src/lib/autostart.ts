import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/**
 * Starting Trackwall at sign-in (ADR-65), switched by the shell: the commands are in
 * `apps/desktop/src-tauri/src/autostart.rs`. The system's start entry is the only record, so the answer is what the
 * system has now. Tauri window only.
 */
const ENABLED_COMMAND = "autostart_enabled";
const SET_COMMAND = "set_autostart";

export async function autostartEnabled(): Promise<boolean> {
  return z.boolean().parse(await invoke<unknown>(ENABLED_COMMAND));
}

/** Turns it on or off and resolves to what the system has afterwards. */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  return z.boolean().parse(await invoke<unknown>(SET_COMMAND, { enabled }));
}
