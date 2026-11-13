/**
 * How a tool "Always allow" remembers (ADR-249) reads in the UI: Copilot CLI's pattern in words, `shell(npm test)` as
 * the command and `trackwall(verify_task)` as the tool of its MCP server.
 */
const PATTERN = /^([A-Za-z0-9_.-]+)\(([^()]+)\)$/;

/** The tool in words: "`npm test`" or "verify_task from trackwall"; the pattern itself when it is neither. */
export function alwaysAllowedToolLabel(tool: string): string {
  const match = PATTERN.exec(tool);
  if (match?.[1] === undefined || match[2] === undefined) return tool;
  return match[1] === "shell" ? `\`${match[2]}\`` : `${match[2]} from ${match[1]}`;
}

/** The button of an approval in a task. */
export function alwaysAllowLabel(tool: string): string {
  return `Always allow ${alwaysAllowedToolLabel(tool)} in this repo's tasks`;
}
