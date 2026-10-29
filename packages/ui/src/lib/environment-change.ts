import type { EnvironmentChange } from "@trackwall/protocol";

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

/** Why the restart waits: it would cut the agent off in the middle of a turn, as closing would. */
export const RESTART_WAITS_FOR_TURN = "The agent is in the middle of a turn; restart once it waits for you";
