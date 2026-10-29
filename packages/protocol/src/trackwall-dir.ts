/**
 * Trackwall's folder in the projects folder (ADR-125): everything Trackwall keeps beside the repos, in one hidden folder
 * with a folder for each purpose. It lies in the projects folder so that git is as fast there as in the repos and an
 * antivirus exclusion of the projects folder covers it; the repo list skips it, like every name with a dot. Trackwall's
 * own memory (settings, tasks, logs, the daemon token) stays in the state folder, `~/.trackwall`.
 */
export const TRACKWALL_DIR = ".trackwall";

/**
 * The folders of `.trackwall`: `local`, the local config store (ADR-86), a git repo of its own; `worktrees`, the default
 * task worktrees folder (ADR-84); `lsp`, each task's Java language server data (ADR-99); `scratch`, git's temporary
 * indexes, removed after each git command (clarification to ADR-31); `removed`, where a removed repo goes (ADR-83).
 * A name alone means nothing in the projects folder, so a path is made only from `TrackwallFolder`.
 */
export type TrackwallFolder = "local" | "worktrees" | "lsp" | "scratch" | "removed";

/** A folder of `.trackwall` as the user reads it, the same on every system: `.trackwall/local`. */
export function trackwallDirLabel(folder: TrackwallFolder): string {
  return `${TRACKWALL_DIR}/${folder}`;
}
