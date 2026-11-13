import type { TaskPause } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";

/**
 * The words of a paused task (ADR-251) in its panel: when it was paused, what Resume brings back, and what the pause
 * stopped, as the daemon named it.
 */

/** "Paused 12 min ago. Resume goes on with its conversation and starts its service again." */
export function pausedNote(pause: TaskPause, now: Date): string {
  const service = pause.service === null ? "" : ` and starts its service again${pause.service.lease ? " on the repo's port" : ""}`;
  return `Paused ${relativeTime(pause.at, now)}. Resume goes on with its conversation${service}.`;
}

/** "Stopped the session, the service on port 41000 and the shell." — `null` when the pause had nothing left to stop. */
export function stoppedNote(stopped: readonly string[]): string | null {
  if (stopped.length === 0) return null;
  const last = stopped[stopped.length - 1];
  const list = stopped.length === 1 ? last : `${stopped.slice(0, -1).join(", ")} and ${last}`;
  return `Stopped ${list}.`;
}

/** The Pause button's tooltip: what a pause stops and what stays. */
export const PAUSE_TITLE =
  "Pause: stop the session, its service, mise tasks, checks and shell to free this computer. The worktree, branch and conversation stay; only you can resume it.";
