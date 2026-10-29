/**
 * Trackwall's folder in the projects folder (ADR-125): everything Trackwall keeps beside the repos, in one hidden folder
 * with a folder for each purpose. It lies in the projects folder so that git is as fast there as in the repos and an
 * antivirus exclusion of the projects folder covers it; the repo list skips it, like every name with a dot. Trackwall's
 * own memory (settings, tasks, logs, the daemon token) stays in the state folder, `~/.trackwall`.
 */
export const TRACKWALL_DIR = ".trackwall";

/** The local config store (ADR-86), a git repo of its own. */
export const LOCAL_CONFIG_STORE_DIR = "local";

/** The default task worktrees folder (ADR-84). */
export const DEFAULT_WORKTREES_DIR_NAME = "worktrees";

/** Each task's Java language server data (ADR-99), one folder per task, deleted when the task ends. */
export const LANGUAGE_SERVER_DIR_NAME = "lsp";

/** Git's temporary indexes, which Trackwall removes after each git command (clarification to ADR-31). */
export const SCRATCH_DIR_NAME = "scratch";

/** Where a removed repo goes (ADR-83). */
export const REMOVED_REPOS_DIR = "removed";

/** A folder of `.trackwall` as the user reads it, the same on every system: `.trackwall/local`. */
export function trackwallDirLabel(name: string): string {
  return `${TRACKWALL_DIR}/${name}`;
}
