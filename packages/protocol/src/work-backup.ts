import { z } from "zod";
import { apiEndpoints } from "./api.ts";

/**
 * Contract of the `work-backup` module (§4.29, ADR-275): a backup of the work that lives only in the container, the
 * commits, stashes and uncommitted changes on no remote with Trackwall's own state, made in one file the user downloads
 * to their computer. Only where the daemon runs in a container (ADR-162). Every action is `POST /api/work-backup/<action>`;
 * the file itself comes from `WORK_BACKUP_DOWNLOAD_PATH`, whose answer is its bytes.
 */

/** What the last backup holds, as the Backup section shows it. */
export const WorkBackupInfo = z.object({
  /** The name the file gets when it is saved: `trackwall-backup-<date>-<time>.tar.gz`. */
  fileName: z.string().min(1),
  createdAt: z.iso.datetime(),
  bytes: z.number().int().nonnegative(),
  /** The repos with work on no remote, each one bundle in the file. */
  repos: z.number().int().nonnegative(),
  /** Local branches with commits on no remote. */
  branches: z.number().int().nonnegative(),
  stashes: z.number().int().nonnegative(),
  /** Worktrees, the repos' own and the tasks', whose uncommitted changes went in. */
  changedWorktrees: z.number().int().nonnegative(),
  /** Trackwall's own files that went in: tasks and their journal, the board, knowledge, routines and templates. */
  stateFiles: z.number().int().nonnegative(),
  /** Repos git could not read, which the backup lacks, with git's message. */
  skipped: z.array(z.object({ repo: z.string().min(1), message: z.string() })),
});
export type WorkBackupInfo = z.infer<typeof WorkBackupInfo>;

export const WorkBackupState = z.object({
  /** Outside a container the repos sit on the computer's own disk, and there is no backup to make (ADR-162). */
  inContainer: z.boolean(),
  /** The last backup still in the state folder; `null` before the first one. */
  last: WorkBackupInfo.nullable(),
  /** A backup is being made right now. */
  running: z.boolean(),
});
export type WorkBackupState = z.infer<typeof WorkBackupState>;

/** A local branch of the backup, and what restoring does with it. */
export const RestoredBranch = z.object({
  /** The branch's name in the backup. */
  name: z.string().min(1),
  commit: z.string().min(1),
  /**
   * `create`: the repo has no branch of that name; `fast-forward`: the repo's branch is behind the backup's and moves
   * forward; `side-branch`: the repo's branch went another way and stays, the backup's commit gets `target` beside it;
   * `unchanged`: the repo has it already; `missing`: the commit is neither in the file nor in this clone.
   */
  action: z.enum(["create", "fast-forward", "side-branch", "unchanged", "missing"]),
  /** The branch that points at the backup's commit afterwards; `null` when missing. */
  target: z.string().nullable(),
  /** The worktree a fast-forward moves with the branch, when the branch is checked out there. */
  worktree: z.string().nullable(),
});
export type RestoredBranch = z.infer<typeof RestoredBranch>;

export const RestoredStash = z.object({
  message: z.string(),
  commit: z.string().nullable(),
  action: z.enum(["add", "unchanged", "missing"]),
});
export type RestoredStash = z.infer<typeof RestoredStash>;

/** A worktree's uncommitted changes, or the commit a worktree was on without a branch, as a branch under `restored/`. */
export const RestoredChanges = z.object({
  /** Where the worktree was in the container the backup came from. */
  worktree: z.string(),
  commit: z.string().nullable(),
  action: z.enum(["create", "unchanged", "missing"]),
  target: z.string().nullable(),
});
export type RestoredChanges = z.infer<typeof RestoredChanges>;

export const RestoredRepo = z.object({
  repo: z.string().min(1),
  /** Where the repo was, relative to the projects folder. */
  path: z.string(),
  /**
   * `ready`: the repo is in the projects folder and takes the backup; `not-cloned`: clone it from one of `remotes` first;
   * `cannot-restore`: git refused, with `message` (most often the clone lacks commits the backup builds on: fetch first).
   */
  state: z.enum(["ready", "not-cloned", "cannot-restore"]),
  message: z.string().nullable(),
  remotes: z.array(z.object({ name: z.string(), url: z.string() })),
  branches: z.array(RestoredBranch),
  stashes: z.array(RestoredStash),
  changes: z.array(RestoredChanges),
});
export type RestoredRepo = z.infer<typeof RestoredRepo>;

/** A file of `.trackwall` in the backup: made when missing, left alone when the projects folder has its own. */
export const RestoredFile = z.object({
  /** Relative to the projects folder, with `/`. */
  path: z.string().min(1),
  action: z.enum(["create", "unchanged", "kept-yours"]),
});
export type RestoredFile = z.infer<typeof RestoredFile>;

/** What restoring the uploaded backup does, repo by repo, as read now; or, from `restore`, what it did. */
export const WorkBackupRestore = z.object({
  createdAt: z.iso.datetime(),
  /** The Trackwall version that made the backup. */
  version: z.string(),
  repos: z.array(RestoredRepo),
  files: z.array(RestoredFile),
  /** Trackwall's own state files in the backup (tasks and their journal), which a restore leaves in the file. */
  stateFilesKept: z.number().int().nonnegative(),
});
export type WorkBackupRestore = z.infer<typeof WorkBackupRestore>;

const endpoint = apiEndpoints("work-backup");

export const workBackupApi = {
  state: endpoint("state", z.object({}).strict(), WorkBackupState),
  /** Makes a new backup in place of the last one and answers what it holds; one at a time, a second call waits for the first. */
  create: endpoint("create", z.object({}).strict(), WorkBackupInfo),
  /** What restoring the uploaded backup would do now; `null` when none is uploaded. */
  restorePlan: endpoint("restorePlan", z.object({}).strict(), WorkBackupRestore.nullable()),
  /** Restores the uploaded backup as `restorePlan` shows it and answers what it did; the file stays until it is discarded. */
  restore: endpoint("restore", z.object({}).strict(), WorkBackupRestore),
  /** Removes the uploaded backup. */
  discardRestore: endpoint("discardRestore", z.object({}).strict(), z.object({})),
};

/** The largest backup file the daemon hands out or takes back: the page holds the whole file in memory (ADR-188). */
export const MAX_WORK_BACKUP_BYTES = 1024 ** 3;

/** `POST` with a backup file's bytes as the body: keeps it for a restore in place of the last one and answers its plan. */
export const WORK_BACKUP_UPLOAD_PATH = "/api/work-backup/upload";

/** `POST` with an empty body: the last backup's bytes, or `not_found` before the first one. */
export const WORK_BACKUP_DOWNLOAD_PATH = "/api/work-backup/download";
