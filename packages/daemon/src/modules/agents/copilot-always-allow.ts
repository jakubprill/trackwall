import { type AgentApproval, type AgentDialog, alwaysAllowable } from "@trackwall/protocol";

/**
 * "Always allow" in a task's approval dialog (ADR-249): the tool permission pattern Copilot CLI itself names in its
 * "don't ask again" option, so Trackwall remembers exactly what Copilot CLI would, but for every task of the repo and
 * where the user can see and remove it. Copilot CLI 1.0.109 names one shell command (`npm test`, `git push`, `mvn -q`)
 * or one MCP tool; it joins several commands with "and", and offers no such option for a command with a redirection or
 * a path to a program, or for a PowerShell command on Windows, so none of those is offered here either. The pattern
 * must also pass `alwaysAllowable`, which refuses anything that reaches past a narrow scope.
 */

/** "Yes, and don't ask again for `npm test` in this repo (/path)". */
const SHELL_OPTION = /^Yes, and don't ask again for `([^`]+)` in this repo\b/;
/** "Yes, and don't ask again for tool "verify_task" from "trackwall" in this repo (/path)". */
const MCP_OPTION = /^Yes, and don't ask again for tool "([^"]+)" from "([^"]+)" in this repo\b/;

/** The questions of a command's and of an MCP tool's approval; a path's or a file's approval asks another. */
const RUN_COMMAND = "Do you want to run this command?";
const USE_TOOL = "Do you want to use this tool?";

/** The pattern of the approval's "don't ask again" option that may be always allowed; `null` for none. */
export function alwaysAllowPattern(dialog: Pick<AgentApproval, "question" | "options">): string | null {
  const labels = dialog.options.map((o) => o.label);
  let pattern: string | null = null;
  if (dialog.question === RUN_COMMAND) {
    const command = labels.map((l) => SHELL_OPTION.exec(l)?.[1]).find((c) => c !== undefined);
    pattern = command === undefined ? null : `shell(${command})`;
  } else if (dialog.question === USE_TOOL) {
    const match = labels.map((l) => MCP_OPTION.exec(l)).find((m) => m !== null);
    pattern = match?.[1] === undefined || match[2] === undefined ? null : `${match[2]}(${match[1]})`;
  }
  return pattern !== null && alwaysAllowable(pattern) ? pattern : null;
}

/** The digit of the approval's plain "Yes", which runs the tool once: what "Always allow" answers. */
export function yesOption(dialog: Pick<AgentApproval, "options">): string | undefined {
  return dialog.options.find((o) => o.label === "Yes")?.key;
}

/** The dialog with what "Always allow" would remember, offered only in a task's session in a repo. */
export function withAlwaysAllow(dialog: AgentDialog | null, place: { repo: string | null; task: string | null }): AgentDialog | null {
  if (dialog?.kind !== "approval" || place.repo === null || place.task === null || yesOption(dialog) === undefined) return dialog;
  const pattern = alwaysAllowPattern(dialog);
  return pattern === null ? dialog : { ...dialog, alwaysAllow: pattern };
}
