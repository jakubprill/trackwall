/** The last segment of a path with `/` or `\` (a Windows path from the daemon); the UI has no `node:path`. */
export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}
