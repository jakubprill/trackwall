import { USAGE_REPORT_MAX_WEEKS_AGO, type UsageTool, type UsageWork, usageReportApi } from "@trackwall/protocol";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { tokenCount, usageDetails, usageLabel } from "@/lib/copilot-usage";
import { toolCalls, toolDefinitionShare, toolName, weekRange, workName, workTokens } from "@/lib/usage-report";
import { useRemote } from "@/lib/use-remote";

/** Rows each list shows before "Show all". */
const TOP_ROWS = 10;

/**
 * The weekly usage report (ADR-195): what Copilot CLI used on this computer in a week, by task and session and by tool,
 * the most first, so the user sees where tokens go and can compare a week with the one before.
 */
export function CopilotUsageSurface({ conn }: { conn: Connection }) {
  const [weeksAgo, setWeeksAgo] = useState(0);
  const load = useCallback(() => post(conn, usageReportApi.week, { weeksAgo }), [conn, weeksAgo]);
  const report = useRemote(load);
  const week = report.data;
  const share = week?.total ? toolDefinitionShare(week.total.inputTokens, week.toolDefinitionTokens) : null;
  return (
    <Surface label="Copilot usage" meta={week ? weekRange(week) : undefined}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          What Copilot CLI used on this computer in a week, from the logs it keeps for every conversation: by task and session, and by tool,
          the most first. It counts every conversation, also those Trackwall did not start.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Previous week"
            disabled={weeksAgo >= USAGE_REPORT_MAX_WEEKS_AGO}
            onClick={() => setWeeksAgo((w) => w + 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="outline" size="sm" aria-label="Next week" disabled={weeksAgo === 0} onClick={() => setWeeksAgo((w) => w - 1)}>
            <ChevronRight aria-hidden />
          </Button>
          <span className="text-sm">{weeksAgo === 0 ? "Last 7 days" : `${weeksAgo} ${weeksAgo === 1 ? "week" : "weeks"} before`}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={report.reload}>
            Refresh
          </Button>
        </div>
        {report.error && <ErrorWithRetry message={report.error} onRetry={report.reload} />}
        {!week && !report.error && <Loading />}
        {week && week.total === null && <p className="text-sm">No model calls this week.</p>}
        {week?.total && (
          <>
            <p className="text-sm" title={usageDetails(week.total)}>
              {usageLabel(week.total)} in total, {tokenCount(week.total.inputTokens)} tokens in and {tokenCount(week.total.outputTokens)}{" "}
              out
              {share !== null && share > 0 && `; ${share}% of the tokens in were tool definitions, sent with every model call`}.
            </p>
            <RankedList
              title="Tasks and sessions"
              rows={week.work}
              rowKey={(w) => JSON.stringify([w.kind, w.task, w.repo, w.label])}
              render={(work) => <WorkRow work={work} />}
            />
            <RankedList
              title="Tools"
              rows={week.tools}
              rowKey={(t) => JSON.stringify([t.server, t.tool])}
              render={(tool) => <ToolRow tool={tool} />}
            />
          </>
        )}
        {week && week.unreadLogs > 0 && (
          <p className="text-muted-foreground text-xs">
            {week.unreadLogs} {week.unreadLogs === 1 ? "log" : "logs"} could not be read, so their use is missing; the daemon log says why.
          </p>
        )}
      </div>
    </Surface>
  );
}

interface RankedListProps<T> {
  title: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  render: (row: T) => ReactNode;
}

function RankedList<T>({ title, rows, rowKey, render }: RankedListProps<T>) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, TOP_ROWS);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="hud-label">{title}</h3>
      <ol className="flex flex-col">
        {shown.map((row) => (
          <li key={rowKey(row)} className="flex min-w-0 items-baseline justify-between gap-3 border-b py-2 last:border-b-0">
            {render(row)}
          </li>
        ))}
      </ol>
      {rows.length > TOP_ROWS && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll((a) => !a)}>
          {all ? "Show the top 10" : `Show all ${rows.length}`}
        </Button>
      )}
    </div>
  );
}

function WorkRow({ work }: { work: UsageWork }) {
  return (
    <>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm" title={workName(work)}>
          {workName(work)}
        </span>
        <span className="text-muted-foreground text-xs">{workTokens(work)}</span>
      </span>
      <span className="text-muted-foreground shrink-0 font-mono text-xs" title={usageDetails(work.usage)}>
        {usageLabel(work.usage)}
      </span>
    </>
  );
}

function ToolRow({ tool }: { tool: UsageTool }) {
  return (
    <>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-sm">{toolName(tool)}</span>
        <span className="text-muted-foreground text-xs">{toolCalls(tool)}</span>
      </span>
      <span className="text-muted-foreground shrink-0 font-mono text-xs">{tokenCount(tool.resultTokens)} tokens</span>
    </>
  );
}
