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

/**
 * What the panel lists: the sessions asking for approval first, since the panel answers them in one click (ADR-66),
 * then task proposals, as in the Sessions view, then the other waiting sessions; each in list order.
 */
export function trayPanelEntries(list: SessionList): {
  approvals: readonly Session[];
  proposals: readonly TaskProposal[];
  sessions: readonly Session[];
} {
  const waiting = list.sessions.filter((s) => s.needsAttention);
  const asksApproval = (s: Session) => s.dialog?.kind === "approval";
  return { approvals: waiting.filter(asksApproval), proposals: list.proposals, sessions: waiting.filter((s) => !asksApproval(s)) };
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
