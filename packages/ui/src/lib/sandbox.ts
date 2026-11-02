import { type SandboxState, sandboxesTask, type TaskApprovals } from "@trackwall/protocol";

/**
 * What the New session form says about Copilot CLI's sandbox for the task being started (ADR-181): `on` when its
 * commands will run in the sandbox, `unavailable` when they should and the sandbox cannot run on this computer, so the
 * daemon will refuse the start; `null` for a task outside the sandbox, or before the daemon answered.
 */
export type SandboxNote = { kind: "on" } | { kind: "unavailable"; problem: string } | null;

export function sandboxNote(state: SandboxState | undefined, approvals: TaskApprovals): SandboxNote {
  if (state === undefined || !sandboxesTask(state.tasks, approvals)) return null;
  return state.problem === null ? { kind: "on" } : { kind: "unavailable", problem: state.problem };
}
