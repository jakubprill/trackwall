import { SessionId, TaskId } from "./agents.ts";
import { RepoId } from "./workspace.ts";

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

/**
 * What looks like a link in running text, for finding links in an agent's answer (a terminal row, Markdown); only
 * `parseTrackwallLink` says whether it is one. The id does not end on a full stop, so the one ending a sentence is not
 * part of it (a `RepoId` may end on `_` or `-`, which no sentence does). A new `RegExp` each time, because a global
 * one keeps its position between searches.
 */
export function trackwallLinkCandidates(): RegExp {
  return new RegExp(`${TRACKWALL_LINK_SCHEME}://[A-Za-z]+/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?/?`, "gi");
}

/** What a link shows; the same shape as the shell's jump (`apps/desktop/src-tauri/src/jump.rs`). */
export type TrackwallLinkTarget = { kind: "repo"; id: RepoId } | { kind: "session"; id: SessionId } | { kind: "task"; id: TaskId };

const WHOLE_LINK = new RegExp(`^${TRACKWALL_LINK_SCHEME}://([a-z]+)/([^/?#]+)/?$`, "i");

/**
 * The target of a link, with the rules of the shell's `parse` in `link.rs`: the scheme and the kind without case, one
 * id and nothing else (no query, fragment, user or port), a session or task UUID in lower case. The id is checked
 * against the protocol schema of its kind, so anything that is not a link to an existing kind of thing is `undefined`.
 */
export function parseTrackwallLink(url: string): TrackwallLinkTarget | undefined {
  const [, kind = "", id = ""] = WHOLE_LINK.exec(url) ?? [];
  switch (kind.toLowerCase()) {
    case "repo": {
      const repo = RepoId.safeParse(id);
      return repo.success ? { kind: "repo", id: repo.data } : undefined;
    }
    case "session": {
      const session = SessionId.safeParse(id.toLowerCase());
      return session.success ? { kind: "session", id: session.data } : undefined;
    }
    case "task": {
      const task = TaskId.safeParse(id.toLowerCase());
      return task.success ? { kind: "task", id: task.data } : undefined;
    }
    default:
      return undefined;
  }
}
