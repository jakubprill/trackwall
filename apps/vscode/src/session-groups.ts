import { countLabel, type NounForms, type ViewerSession, type ViewerSessionList } from "@trackwall/protocol";
import type { ViewerRead } from "./viewer-client.ts";

/**
 * What the side bar and the status bar show from one look at the daemon, without VS Code's API, so a test reads it as
 * plain data. The states are named in the UI's words, which the daemon sends (`sessionStateLabel`).
 */

type GroupId = "waiting" | "running" | "ended";

export interface SessionRow {
  id: string;
  /** What the session is about: its task, the agent's window title, or its place. */
  label: string;
  /** Where it works and its state: "shop · asking for approval". */
  description: string;
  tone: ViewerSession["status"]["tone"];
  live: boolean;
}

export interface SessionGroup {
  id: GroupId;
  label: string;
  rows: SessionRow[];
}

const SESSIONS: NounForms = { one: "session", other: "sessions" };
const PROPOSALS: NounForms = { one: "task proposal", other: "task proposals" };

const GROUP_LABELS: Record<GroupId, string> = { waiting: "Waiting for you", running: "Running", ended: "Ended" };

function groupOf(session: ViewerSession): GroupId {
  if (!session.live) return "ended";
  return session.needsAttention ? "waiting" : "running";
}

function row(session: ViewerSession): SessionRow {
  const label = session.taskName ?? session.windowTitle ?? session.place;
  return {
    id: session.id,
    label,
    description: `${session.place} · ${session.status.label}`,
    tone: session.status.tone,
    live: session.live,
  };
}

/** The non-empty groups in the order of urgency, each in the daemon's order (newest first). */
export function sessionGroups(list: ViewerSessionList): SessionGroup[] {
  const order: GroupId[] = ["waiting", "running", "ended"];
  return order.flatMap((id) => {
    const rows = list.sessions.filter((s) => groupOf(s) === id).map(row);
    return rows.length === 0 ? [] : [{ id, label: GROUP_LABELS[id], rows }];
  });
}

export interface StatusBarState {
  text: string;
  tooltip: string;
  /** Draws the item in the warning colours: something waits for you. */
  warning: boolean;
}

/**
 * The status bar item: what waits for you (sessions and task proposals, the supervisor included, like the desktop app's
 * badge), otherwise how many sessions run; `undefined` hides it while viewer access is off.
 */
export function statusBarState(read: ViewerRead): StatusBarState | undefined {
  if (read.kind === "off") return undefined;
  if (read.kind === "unavailable") return { text: "$(debug-disconnect) Trackwall", tooltip: `Trackwall: ${read.reason}`, warning: false };
  const { sessions, proposals } = read.list;
  const waiting = sessions.filter((s) => s.live && s.needsAttention).length + proposals;
  if (waiting > 0) {
    const parts = [
      ...(waiting - proposals > 0 ? [countLabel(waiting - proposals, SESSIONS)] : []),
      ...(proposals > 0 ? [countLabel(proposals, PROPOSALS)] : []),
    ];
    return { text: `$(bell) ${waiting} waiting`, tooltip: `Trackwall: ${parts.join(" and ")} waiting for you`, warning: true };
  }
  const running = sessions.filter((s) => s.live).length;
  return running === 0
    ? { text: "$(check) Trackwall", tooltip: "Trackwall: no session is running", warning: false }
    : {
        text: `$(pulse) ${running} running`,
        tooltip: `Trackwall: ${countLabel(running, SESSIONS)} running, none waiting for you`,
        warning: false,
      };
}
