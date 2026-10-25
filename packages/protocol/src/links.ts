/**
 * `trackwall://` links (ADR-52): a link to a repo, a session or a task shows it in the Trackwall window, so an agent
 * or a notification can point the user at it. The desktop shell parses them (`apps/desktop/src-tauri/src/link.rs`);
 * a link only switches the view, never runs anything. A task link also opens a task proposal, which has the id of the
 * task it becomes.
 */
export const TRACKWALL_LINK_SCHEME = "trackwall";

/** What a link can point at; the id is a `RepoId`, `SessionId` or `TaskId`. */
export const TRACKWALL_LINK_KINDS = ["repo", "session", "task"] as const;
export type TrackwallLinkKind = (typeof TRACKWALL_LINK_KINDS)[number];

/** The id goes in as it is: ids have only URL-safe characters, and the MCP instruction passes placeholders like `<repo id>`. */
export function trackwallLink(kind: TrackwallLinkKind, id: string): string {
  return `${TRACKWALL_LINK_SCHEME}://${kind}/${id}`;
}
