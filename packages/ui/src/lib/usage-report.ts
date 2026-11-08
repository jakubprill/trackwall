import { countLabel, type UsageReport, type UsageTool, type UsageWork } from "@trackwall/protocol";
import { tokenCount } from "./copilot-usage.ts";

/**
 * How Settings shows the weekly usage report (ADR-199): a name for each piece of work, the week's dates, and how much
 * of what the model read was tool definitions, the cost every call pays before any work.
 */

/** The task's title, or what the work was when it has none of its own. */
export function workName(work: UsageWork): string {
  switch (work.kind) {
    case "task":
      return work.label;
    case "supervisor":
      return "Supervisor";
    case "repo":
      return `Sessions in ${work.repo ?? "a repo"}`;
    case "outside":
      return "Copilot CLI outside the projects folder";
  }
}

/** "Nov 4", a day in the viewer's time zone. */
function shortDay(time: number, locale: string | undefined): string {
  return new Date(time).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The week's last day; `to` is the moment the week ended and not part of it, so one that ended at midnight ends the day before. */
export function weekLastDay(report: Pick<UsageReport, "to">, locale?: string): string {
  return shortDay(Date.parse(report.to) - 1, locale);
}

/** "Oct 28 – Nov 4", in the viewer's time zone. */
export function weekRange(report: Pick<UsageReport, "from" | "to">, locale?: string): string {
  return `${shortDay(Date.parse(report.from), locale)} – ${weekLastDay(report, locale)}`;
}

/** The share of input tokens that were tool definitions, in whole percent; `null` with no input. */
export function toolDefinitionShare(inputTokens: number, toolDefinitionTokens: number): number | null {
  if (inputTokens === 0) return null;
  return Math.round((toolDefinitionTokens / inputTokens) * 100);
}

/** "1.2M in · 40% tool definitions · 12k out". */
export function workTokens(work: UsageWork): string {
  const share = toolDefinitionShare(work.usage.inputTokens, work.toolDefinitionTokens);
  const parts = [`${tokenCount(work.usage.inputTokens)} in`];
  if (share !== null && share > 0) parts.push(`${share}% tool definitions`);
  parts.push(`${tokenCount(work.usage.outputTokens)} out`);
  return parts.join(" · ");
}

/** The tool as the model saw it: `jira / get_issue`, or a built-in tool's own name. */
export function toolName(tool: Pick<UsageTool, "tool" | "server">): string {
  return tool.server === null ? tool.tool : `${tool.server} / ${tool.tool}`;
}

/** "12 calls · 2 failed". */
export function toolCalls(tool: UsageTool): string {
  const calls = countLabel(tool.calls, { one: "call", other: "calls" });
  return tool.failures === 0 ? calls : `${calls} · ${tool.failures} failed`;
}

/** A ranked row's bar (ADR-236): its value as a share of the list's largest, in percent. */
export function rankShare(value: number, largest: number): number {
  return largest <= 0 ? 0 : (value / largest) * 100;
}
