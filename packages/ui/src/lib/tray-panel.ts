import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionList, TaskProposal } from "@trackwall/protocol";
import type { Jump } from "./use-jump-request.ts";

/**
 * The tray panel (ADR-50): a small window of the Tauri shell next to the tray icon, with the sessions waiting for you
 * and the task proposals. The shell opens it with this fragment (`PAGE` in `apps/desktop/src-tauri/src/tray_panel.rs`).
 */
const TRAY_PANEL_HASH = "#tray-panel";

export function isTrayPanel(hash: string): boolean {
  return hash === TRAY_PANEL_HASH;
}

/** What the panel lists: task proposals first, as in the Sessions view, then the waiting sessions, in list order. */
export function trayPanelEntries(list: SessionList): { proposals: readonly TaskProposal[]; sessions: readonly Session[] } {
  return { proposals: list.proposals, sessions: list.sessions.filter((s) => s.needsAttention) };
}

/** What a click in the panel opens: the shell passes it on as a jump (`jump.rs`). */
export type TrayPanelTarget = Extract<Jump, { kind: "session" | "proposal" }>;

/**
 * The shell hides the panel and jumps to the target in the window for sessions, or shows the main window without one
 * for "Open Trackwall"
 * (`open_from_tray_panel` in `main.rs`).
 */
export function openFromTrayPanel(target?: TrayPanelTarget): Promise<void> {
  return invoke("open_from_tray_panel", { target: target ?? null });
}
