import { z } from "zod";
import { apiEndpoints } from "./api.ts";

/**
 * Contract of the `work-backup` module (§4.29, ADR-274): a backup of the work that lives only in the container, the
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

const endpoint = apiEndpoints("work-backup");

export const workBackupApi = {
  state: endpoint("state", z.object({}).strict(), WorkBackupState),
  /** Makes a new backup in place of the last one and answers what it holds; one at a time, a second call waits for the first. */
  create: endpoint("create", z.object({}).strict(), WorkBackupInfo),
};

/** `POST` with an empty body: the last backup's bytes, or `not_found` before the first one. */
export const WORK_BACKUP_DOWNLOAD_PATH = "/api/work-backup/download";
