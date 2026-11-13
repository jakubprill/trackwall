import type { SessionList, TrackwallLinkTarget } from "@trackwall/protocol";
import { type SessionEntry, selectedEntry } from "./session-entries.ts";
import { selectsSupervisor } from "./supervisor.ts";

/**
 * A `trackwall://` link to a session or task (ADR-52) opens only what the session list holds. A link may come from
 * anywhere, also from another daemon (the VS Code extension next to a daemon in a dev container, ADR-221) or after its
 * session ended, and Sessions falls back to its first entry for an unknown selection (`findEntry`), which would show
 * another session without a word (`use-session-link.ts`).
 */
export type SessionLinkTarget = Extract<TrackwallLinkTarget, { kind: "session" | "task" }>;

/** Whether the list holds the target: an entry, or the supervisor's session, whose panel opens instead (ADR-58). */
export function sessionLinkKnown(list: SessionList | undefined, entries: readonly SessionEntry[], target: SessionLinkTarget): boolean {
  return list !== undefined && (selectsSupervisor(list, target) || selectedEntry(entries, target) !== undefined);
}

/** What the user reads when a list fetched after the link still does not hold its target. */
export function unknownLinkMessage(target: SessionLinkTarget): string {
  return (
    `The link points to a ${target.kind} this Trackwall does not have (${target.id}). ` +
    "It may have ended, or the link comes from Trackwall running somewhere else, such as in a dev container."
  );
}
