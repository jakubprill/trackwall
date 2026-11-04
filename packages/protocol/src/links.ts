import { z } from "zod";
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
 * `parseTrackwallLink` says whether it is one. A candidate is a whole word: nothing that continues an address stands
 * right before or after it, so `trackwall://repo/orders/main` or `…/orders?run=1` is no candidate rather than a shorter
 * link than the text shows. A full stop, question mark or bracket that ends a sentence is not part of it (a `RepoId` may
 * end on `_` or `-`, which no sentence does). A new `RegExp` for each search, so no caller shares its `lastIndex`.
 */
export function trackwallLinkCandidates(): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9.+-])${TRACKWALL_LINK_SCHEME}://[A-Za-z]+/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?/?(?![A-Za-z0-9_/%-]|[.?#&=][A-Za-z0-9])`,
    "gi",
  );
}

/** What a link shows; the same kinds as the shell's jump (`apps/desktop/src-tauri/src/jump.rs`). */
export const TrackwallLinkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo"), id: RepoId }),
  z.object({ kind: z.literal("session"), id: SessionId }),
  z.object({ kind: z.literal("task"), id: TaskId }),
]);
export type TrackwallLinkTarget = z.infer<typeof TrackwallLinkTarget>;

const WHOLE_LINK = new RegExp(`^${TRACKWALL_LINK_SCHEME}://([a-z]+)/([^/?#]+)/?$`, "i");

/**
 * The target of a link, at least as strict as the shell's `parse` in `link.rs`: the scheme and the kind without case,
 * one id and nothing else (no query, fragment, user, port or empty segment), a session or task UUID in lower case, the
 * id checked against the protocol schema of its kind. Anything else is `undefined`.
 */
export function parseTrackwallLink(url: string): TrackwallLinkTarget | undefined {
  const [, kind, id] = WHOLE_LINK.exec(url) ?? [];
  if (kind === undefined || id === undefined) return undefined;
  const lower = kind.toLowerCase();
  const target = TrackwallLinkTarget.safeParse({ kind: lower, id: lower === "repo" ? id : id.toLowerCase() });
  return target.success ? target.data : undefined;
}
