import { isAbsolute, relative, sep } from "node:path";

/**
 * `path` is `root` or lies under it, by resolved paths; the one containment check for paths that must not leave a
 * directory (static UI files, the mise files of a task worktree, ADR-59). Cross-drive paths on Windows are outside.
 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
