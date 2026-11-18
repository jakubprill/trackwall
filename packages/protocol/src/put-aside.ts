import { z } from "zod";

/**
 * Changes put aside so a pull can go on (ADR-270): the tracked changes of the working directory moved into a git stash
 * whose message starts with `PUT_ASIDE_MESSAGE`, never deleted. Untracked files stay where they are, since they never
 * stop a fast-forward. The stash is git's own, so the user can also bring it back with `git stash pop`.
 */

/** The start of the stash message; the daemon lists only stashes that start with it. */
export const PUT_ASIDE_MESSAGE = "Trackwall: put aside before a pull";

/** A changed tracked file that a put-aside moves into the stash: staged or not, with how git sees it against HEAD. */
export const PutAsideFile = z.object({ path: z.string(), change: z.enum(["added", "modified", "deleted"]) });
export type PutAsideFile = z.infer<typeof PutAsideFile>;

/** The commit of a stash entry, which stays the same while newer stashes shift the `stash@{n}` numbers. */
export const PutAsideId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "a stash commit id is 40 or 64 hex digits");

/** One put-aside in the repo's stash list, newest first. */
export const PutAside = z.object({
  id: PutAsideId,
  /** The branch the changes were on; `null` when they were made on a detached HEAD. */
  branch: z.string().nullable(),
  /** ISO 8601. */
  at: z.string(),
  files: z.array(z.string()),
});
export type PutAside = z.infer<typeof PutAside>;
