import { toolPatternParts } from "@trackwall/protocol";

/**
 * How a tool "Always allow" remembers (ADR-249) reads in the UI: Copilot CLI's pattern in words, `shell(npm test)` as
 * the command and `trackwall(verify_task)` as the tool of its MCP server.
 */

/** The tool in words: "`npm test`" or "verify_task from trackwall"; the pattern itself when it is neither. */
export function alwaysAllowedToolLabel(tool: string): string {
  const parts = toolPatternParts(tool);
  if (parts === null) return tool;
  return parts.kind === "shell" ? `\`${parts.argument}\`` : `${parts.argument} from ${parts.kind}`;
}

/** The button of an approval in a task. */
export function alwaysAllowLabel(tool: string): string {
  return `Always allow ${alwaysAllowedToolLabel(tool)} in this repo's tasks`;
}
