/**
 * Paths as typed into a session: separated by spaces and followed by one, so the user can keep typing, like a file
 * dropped on a system terminal. A path with a space or a quote goes in double quotes, with `"` escaped, because
 * the agent reads the line as words.
 */
export function pastedPaths(paths: readonly string[]): string {
  return `${paths.map((path) => (/[\s"']/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path)).join(" ")} `;
}
