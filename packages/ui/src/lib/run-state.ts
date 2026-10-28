import type { ExitedRun, RunState } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * The state of a run (`RunState`, §4.1) in one line; today mise tasks show it, later services. Only what needs attention
 * or is running has a tone; a mise task never run and one stopped by the user have no tone (plain text).
 */
export function runStateLabel(run: RunState | null): { tone?: StatusTone; label: string } {
  if (!run) return { label: "not started" };
  if (run.kind === "running") return { tone: "ok", label: "running" };
  if (run.kind === "stopping") return { tone: "warning", label: "stopping" };
  if (run.stoppedByUser) return { label: "stopped" };
  if (run.exitCode === 0) return { label: "finished" };
  return { tone: "error", label: run.exitCode === null ? `killed (${run.signal ?? "signal"})` : `failed, code ${run.exitCode}` };
}

/** The last output lines are shown only when the mise task ended on its own and not with code 0. */
export function showsLastLines(run: RunState | null): run is ExitedRun {
  return run?.kind === "exited" && !run.stoppedByUser && run.exitCode !== 0 && run.lastLines.length > 0;
}

/** A running mise task has the "Stop" button, any other "Run". */
export function isLive(run: RunState | null): boolean {
  return run?.kind === "running" || run?.kind === "stopping";
}
