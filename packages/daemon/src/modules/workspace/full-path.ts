import path, { type PlatformPath } from "node:path";

/**
 * A full path on the user's disk (the projects folder in `workspace.yaml` and in the settings): on Windows
 * with a drive letter or UNC. `\projects` is absolute for `isAbsolute`, but points to the drive the daemon
 * happened to start from; `~` is not expanded, and a relative path depends on the daemon's directory.
 */
export function isFullPath(p: string, paths: PlatformPath = path): boolean {
  return paths.isAbsolute(p) && (paths.sep === "/" || paths.parse(p).root.length > 1);
}

export const NOT_FULL_PATH =
  "the projects folder must be a full path: on Windows with a drive letter (C:\\...) or \\\\server\\share, without `~` and not relative";

export const NOT_FULL_PROGRAM_PATH =
  "the git program must be a full path to git (git.exe on Windows), not a name from PATH and not relative";
