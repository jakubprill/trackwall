/** Whether a path segment is fixed text, not a variable (`{id}`, `*`) or the rest of the path (`**`). */
export function isLiteral(segment: string): boolean {
  return !segment.startsWith("{") && segment !== "*" && segment !== "**";
}
