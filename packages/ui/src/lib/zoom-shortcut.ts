import { invoke } from "@tauri-apps/api/core";

/**
 * Zoom of the window's page (ADR-65): Ctrl+= or Ctrl++ zooms in, Ctrl+- out, Ctrl+0 back to actual size (⌘ on macOS).
 * The shell zooms and remembers the level per window, because a web view cannot tell its own zoom; the step names
 * are `ZoomStep` in `apps/desktop/src-tauri/src/zoom.rs`. In a browser the browser's own zoom does the same, so the
 * UI leaves those keys alone there.
 */
export type ZoomStep = "in" | "out" | "reset";

const ZOOM_COMMAND = "zoom_window";

type KeyPress = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/**
 * The step of a key press. Plus and minus by the character (`key`), with or without Shift, because "+" needs Shift on
 * some layouts and the numeric keypad has both; zero by the key (`code`), because on AZERTY the zero key without Shift
 * gives another character, and from the numeric keypad only with NumLock on, because without it that key is Insert
 * (Ctrl+Insert copies).
 */
export function zoomStepOf(press: KeyPress, isMac: boolean): ZoomStep | undefined {
  const command = isMac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (!command || press.altKey) return undefined;
  if (press.key === "=" || press.key === "+") return "in";
  if (press.key === "-") return "out";
  if (!press.shiftKey && (press.code === "Digit0" || (press.code === "Numpad0" && press.key === "0"))) return "reset";
  return undefined;
}

export async function zoomWindow(step: ZoomStep): Promise<void> {
  await invoke(ZOOM_COMMAND, { step });
}
