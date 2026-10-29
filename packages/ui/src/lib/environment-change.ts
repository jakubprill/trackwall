import type { EnvironmentChange, Session } from "@trackwall/protocol";
import { closeCutsOffTurn } from "./session-state.ts";

/**
 * What the session panel says when mise would give a running session another environment than it started with
 * (ADR-119): one part per kind of change, by name only, never with values.
 */
export function environmentChangeParts(change: EnvironmentChange): string[] {
  const parts: [string, readonly string[]][] = [
    ["new", change.added],
    ["changed", change.changed],
    ["removed", change.removed],
    ["now for the agent's tools", change.shared],
    ["no longer for the agent's tools", change.unshared],
  ];
  return parts.filter(([, names]) => names.length > 0).map(([label, names]) => `${label}: ${names.join(", ")}`);
}

/**
 * The restart button of a session whose environment changed: off while a restart runs, while the session is no longer
 * running (the restart's own stop, or the user's), and while the agent is in the middle of a turn, which the stop would
 * cut off, as closing would.
 */
export function restartButton(session: Session | undefined, pending: boolean): { disabled: boolean; title: string } {
  if (session !== undefined && closeCutsOffTurn(session))
    return { disabled: true, title: "The agent is in the middle of a turn; restart once it waits for you" };
  return {
    disabled: pending || session?.run.kind !== "running",
    title: "Stop the session and start it again with the same conversation and the new environment",
  };
}
