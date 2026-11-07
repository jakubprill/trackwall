import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/**
 * Keeping the screen on (ADR-218), held by the desktop shell: the setting and the system's power request are in
 * `apps/desktop/src-tauri/src/keep_screen_on.rs`. Tauri window only.
 */
const GET_COMMAND = "keep_screen_on";
const SET_COMMAND = "set_keep_screen_on";

export const KeepScreenOn = z.enum(["off", "while-agents-work", "always"]);
export type KeepScreenOn = z.infer<typeof KeepScreenOn>;

/** The choices in Settings, in the order shown. */
export const KEEP_SCREEN_ON_CHOICES: readonly { value: KeepScreenOn; label: string }[] = [
  { value: "off", label: "Off: the system's power settings decide" },
  { value: "while-agents-work", label: "While agents work" },
  { value: "always", label: "Always, while Trackwall runs" },
];

export async function keepScreenOn(): Promise<KeepScreenOn> {
  return KeepScreenOn.parse(await invoke<unknown>(GET_COMMAND));
}

/** Saves the setting and resolves to what the shell has saved afterwards. */
export async function setKeepScreenOn(setting: KeepScreenOn): Promise<KeepScreenOn> {
  return KeepScreenOn.parse(await invoke<unknown>(SET_COMMAND, { setting }));
}
