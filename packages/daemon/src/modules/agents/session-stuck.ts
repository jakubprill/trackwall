import type { SessionStuck, TaskStateChange } from "@trackwall/protocol";

/**
 * When a session may be stuck (ADR-151, `SessionStuck`): the one rule both views use. The time comes from the agent's
 * steps (hooks, ACP updates, the user's keys), never from the output: Copilot CLI's spinner keeps printing while a
 * command hangs, which is why `Stale` alone does not catch it.
 */

/**
 * No step for this long in the middle of a turn: longer than a slow Maven build on a managed machine, which the agent
 * runs as one tool call, so a build alone is not flagged.
 */
export const STUCK_AFTER_MS = 15 * 60_000;

/** States in the middle of a turn that the agent itself ends; `Approval` and `Plan` wait for the user, which is not hanging. */
const BUSY_STATES: ReadonlySet<TaskStateChange["state"]> = new Set(["Working", "Stale"]);

/** `null` unless the session is busy and its last step is `STUCK_AFTER_MS` or more before `now`. */
export function sessionStuck(state: TaskStateChange | null, lastStepAt: number, now: number): SessionStuck | null {
  if (state === null || !BUSY_STATES.has(state.state) || now - lastStepAt < STUCK_AFTER_MS) return null;
  return { lastStepAt: new Date(lastStepAt).toISOString() };
}
