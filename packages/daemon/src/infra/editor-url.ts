/**
 * Opening a directory (a repo or a task worktree) or a file (a config file, ADR-108) in VS Code; assembled in the facade
 * and given to modules as `openEditor`, so the address rule is in one place.
 *
 * The address that opens a directory in VS Code through the system mechanism for opening URLs, without running `code`
 * through a shell: `vscode://file/C:/repo` on Windows, `vscode://file/Users/me/repo` on macOS.
 */
export function vscodeUrl(dir: string): string {
  const segments = dir.replaceAll("\\", "/").split("/");
  // `#`, `?` and `%` in a directory name must be encoded; the drive letter's colon stays.
  const encoded = segments.map((s) => encodeURIComponent(s).replaceAll("%3A", ":")).join("/");
  return `vscode://file${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
}
