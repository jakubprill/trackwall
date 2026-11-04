import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { CopilotUsage } from "./copilot-usage.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `usage-report` module (ADR-195): what Copilot CLI used in one week on this computer, from the event
 * logs it keeps for every conversation, by the work it was for and by the tools whose results went to the model, so
 * the user sees where tokens go and can compare one week with another after a change. Every action is
 * `POST /api/usage-report/<action>`.
 */

/** A report covers this many days, up to the moment it is read for the current week. */
export const USAGE_REPORT_DAYS = 7;
/** How far back the report goes, in weeks; Copilot CLI may have removed older conversations anyway. */
export const USAGE_REPORT_MAX_WEEKS_AGO = 12;
/** A label longer than this (a task's prompt) is cut. */
export const USAGE_REPORT_LABEL_MAX_CHARS = 120;

/**
 * What a conversation worked for, from the folder and branch Copilot CLI recorded for it: a Trackwall task (its
 * worktree on a task branch), the supervisor (the projects folder), a session in a repo's folder, or a folder outside
 * the projects folder.
 */
export const UsageWorkKind = z.enum(["task", "supervisor", "repo", "outside"]);
export type UsageWorkKind = z.infer<typeof UsageWorkKind>;

/** The conversations of one piece of work and what their model calls used in the week. */
export const UsageWork = z.object({
  kind: UsageWorkKind,
  /** The task, when Trackwall still has it or its record in the task journal; `null` otherwise. */
  task: TaskId.nullable(),
  /** The task's repo or the repo whose folder the session ran in; `null` for the supervisor and outside. */
  repo: RepoId.nullable(),
  /**
   * The task's title or the first line of its prompt, or its branch when Trackwall no longer knows the task; empty for
   * the other kinds, which the UI names itself.
   */
  label: z.string(),
  conversations: z.number().int().positive(),
  usage: CopilotUsage,
  /** Input tokens that were the tool definitions sent with every model call, part of `usage.inputTokens`. */
  toolDefinitionTokens: z.number().int().nonnegative(),
});
export type UsageWork = z.infer<typeof UsageWork>;

/** One tool's calls in the week, over all conversations. */
export const UsageTool = z.object({
  /** The tool's own name: an MCP tool's name on its server, a built-in tool's name in Copilot CLI (`view`, `bash`). */
  tool: z.string(),
  /** The MCP server, as named in the user's or Trackwall's MCP config; `null` for Copilot CLI's built-in tools. */
  server: z.string().nullable(),
  calls: z.number().int().nonnegative(),
  /** Calls that ended in an error. */
  failures: z.number().int().nonnegative(),
  /** Tokens of the results that went to the model, as Copilot CLI counted them; an error's text is not counted. */
  resultTokens: z.number().int().nonnegative(),
});
export type UsageTool = z.infer<typeof UsageTool>;

export const UsageReport = z.object({
  /** The week's start and end, ISO 8601; the end is the moment of reading for the current week. */
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  /** All model calls of the week; `null` when there were none. */
  total: CopilotUsage.nullable(),
  /** Input tokens of the week that were tool definitions. */
  toolDefinitionTokens: z.number().int().nonnegative(),
  /** The most used first, by input tokens. */
  work: z.array(UsageWork),
  /** The most used first, by result tokens, then by calls. */
  tools: z.array(UsageTool),
  /** Event logs of the week that could not be read (a file held by another program); their use is missing. */
  unreadLogs: z.number().int().nonnegative(),
});
export type UsageReport = z.infer<typeof UsageReport>;

const endpoint = apiEndpoints("usage-report");

export const usageReportApi = {
  /** The week that ended `weeksAgo` weeks ago: 0 is the last `USAGE_REPORT_DAYS` days up to now. */
  week: endpoint("week", z.object({ weeksAgo: z.number().int().min(0).max(USAGE_REPORT_MAX_WEEKS_AGO) }).strict(), UsageReport),
};
