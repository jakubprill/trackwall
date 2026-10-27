import type { Stats } from "node:fs";

/**
 * Whether a file changed between two `stat` calls, without reading it: for `vcs` (the git directory's files, ADR-63) and
 * `local-config` (a repo's local config files, ADR-86). Size and file identity next to the time: a rename over the file
 * (git, an editor saving) gives a new identity even within one timestamp tick.
 */
export function fileKey(info: Stats): string {
  return `${info.mtimeMs}:${info.size}:${info.ino}`;
}
