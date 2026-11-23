import { z } from "zod";

/**
 * `manifest.json` of a work backup (ADR-275): what each entry of the archive is, so that a restore reads the file
 * without guessing. It is parsed with this schema on the way back in, since a file the user hands Trackwall is input
 * from outside like any other. `format` changes when the meaning of an entry does.
 */

export const BACKUP_FORMAT = 1;

const ObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const RefName = z.string().regex(/^refs\/[^\0\n]+$/);

const BackupWorktree = z.object({
  path: z.string().min(1),
  branch: RefName.nullable(),
  head: ObjectId.nullable(),
  /** The ref of a commit with the worktree's uncommitted changes on top of `head`, or `null` without changes. */
  changes: RefName.nullable(),
});

export const BackupRepo = z.object({
  repo: z.string().min(1),
  /** Where the repo was, relative to the projects folder. */
  path: z.string().min(1),
  /** The archive entry with the repo's bundle. */
  entry: z.string().regex(/^repos\/\d+\.bundle$/),
  objectFormat: z.enum(["sha1", "sha256"]),
  remotes: z.array(z.object({ name: z.string().min(1), url: z.string().min(1) })),
  branches: z.array(z.object({ name: RefName, commit: ObjectId })),
  stashes: z.array(z.object({ ref: RefName, message: z.string() })),
  worktrees: z.array(BackupWorktree),
  refs: z.array(RefName),
});
export type BackupRepo = z.infer<typeof BackupRepo>;

const BackupStateFile = z.object({
  entry: z.string().regex(/^state\/\d+$/),
  /** `state`: a file of the state folder by its name; `projects`: a file of `.trackwall` in the projects folder. */
  place: z.enum(["state", "projects"]),
  path: z.string().min(1),
});
export type BackupStateFile = z.infer<typeof BackupStateFile>;

export const BackupManifest = z.object({
  format: z.literal(BACKUP_FORMAT),
  createdAt: z.iso.datetime(),
  /** The Trackwall version that made the backup. */
  version: z.string().min(1),
  projectsDir: z.string().min(1),
  repos: z.array(BackupRepo),
  state: z.array(BackupStateFile),
});
export type BackupManifest = z.infer<typeof BackupManifest>;
