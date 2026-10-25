import { z } from "zod";

/**
 * Working directory changes against a commit: a task worktree against its base commit (ADR-31) and the working directory
 * of a repo in the projects folder against HEAD (the "Changes" tab, ADR-34). The same git read in both places.
 */

/** A file changed against the commit; `null` line counts for a binary file. A new file, untracked included, is `added`. */
export const ChangedFile = z.object({
  path: z.string(),
  change: z.enum(["added", "modified", "deleted"]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/** The diff limit in `WorkingTreeChanges.patch`: nobody scrolls further anyway, and the rest is better read in VS Code. */
export const PATCH_MAX_BYTES = 1024 * 1024;

/** The working directory (with new files, without ignored ones) against a commit. */
export const WorkingTreeChanges = z.object({
  files: z.array(ChangedFile),
  /** The unified diff, cut after its last whole line within the limit (`PATCH_MAX_BYTES` in the UI). */
  patch: z.string(),
  /** The diff or the file list is cut. */
  truncated: z.boolean(),
});
export type WorkingTreeChanges = z.infer<typeof WorkingTreeChanges>;
