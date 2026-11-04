/**
 * Opening a directory (a repo or a task worktree) or a file (a config file, ADR-108; a file of a session's conversation at
 * a line, ADR-107) in VS Code; assembled in the facade and given to modules as `openEditor`, so the address rule is in
 * one place.
 *
 * The address that opens a directory in VS Code through the system mechanism for opening URLs, without running `code`
 * through a shell: `vscode://file/C:/repo` on Windows, `vscode://file/Users/me/repo` on macOS, and a file at a line with
 * `:<line>` after it.
 */
export function vscodeUrl(path: string, line?: number): string {
  const segments = path.replaceAll("\\", "/").split("/");
  // `#`, `?` and `%` in a directory name must be encoded; the drive letter's colon stays.
  const encoded = segments.map((s) => encodeURIComponent(s).replaceAll("%3A", ":")).join("/");
  const url = `vscode://file${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
  return line === undefined ? url : `${url}:${line}`;
}
