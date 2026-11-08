import { USAGE_REPORT_MAX_WEEKS_AGO, type UsageTool, type UsageWork, usageReportApi } from "@trackwall/protocol";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { StatTile } from "@/components/StatTile";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { tokenCount, usageDetails, usageLabel } from "@/lib/copilot-usage";
import { rankShare, toolCalls, toolDefinitionShare, toolName, weekRange, workName, workTokens } from "@/lib/usage-report";
import { useRemote } from "@/lib/use-remote";
import { UsageTrend } from "./UsageTrend";

/** Rows each list shows before "Show all". */
const TOP_ROWS = 10;

/**
 * The weekly usage report (ADR-199) in Settings › Usage (ADR-212): what Copilot CLI used on this computer in a week,
 * its total as a few numbers, then by task and session and by tool, the most first, side by side when there is room, so
 * the user sees where tokens go and can compare a week with the one before. Above them the trend of every week
 * (ADR-236), whose bars pick the week, and a bar under every ranked row, its share of the first.
 */
export function CopilotUsageSurface({ conn }: { conn: Connection }) {
  const [weeksAgo, setWeeksAgo] = useState(0);
  const load = useCallback(() => post(conn, usageReportApi.week, { weeksAgo }), [conn, weeksAgo]);
  const report = useRemote(load);
  const loadTrend = useCallback(() => post(conn, usageReportApi.trend, {}), [conn]);
  const trend = useRemote(loadTrend);
  const refresh = () => {
    report.reload();
    trend.reload();
  };
  const week = report.data;
  const share = week?.total ? toolDefinitionShare(week.total.inputTokens, week.toolDefinitionTokens) : null;
  return (
    <Surface label="Copilot usage" meta={week ? weekRange(week) : undefined}>
      <div className="@container flex flex-col gap-4 p-4">
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
          <Button variant="ghost" size="sm" className="ml-auto" onClick={refresh}>
            Refresh
          </Button>
        </div>
        {trend.error && <ErrorWithRetry message={trend.error} onRetry={trend.reload} />}
        {trend.data ? (
          <UsageTrend trend={trend.data} weeksAgo={weeksAgo} onPick={setWeeksAgo} />
        ) : (
          // The chart's height while it loads, so the week's report below does not jump when it comes.
          !trend.error && <div aria-hidden className="h-46" />
        )}
        {report.error && <ErrorWithRetry message={report.error} onRetry={report.reload} />}
        {!week && !report.error && <Loading />}
        {week && week.total === null && <p className="text-sm">No model calls this week.</p>}
        {week?.total && (
          <>
            <dl className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
              <StatTile label="Used" title={usageDetails(week.total)}>
                <Big>{usageLabel(week.total)}</Big>
              </StatTile>
              <StatTile label="Tokens in">
                <Big>{tokenCount(week.total.inputTokens)}</Big>
              </StatTile>
              <StatTile label="Tokens out">
                <Big>{tokenCount(week.total.outputTokens)}</Big>
              </StatTile>
              {share !== null && share > 0 && (
                <StatTile label="Tool definitions" title="Tool definitions are sent with every model call, used or not">
                  <Big>{share}%</Big> of tokens in
                </StatTile>
              )}
            </dl>
            <div className="grid gap-6 @3xl:grid-cols-2">
              <RankedList
                title="Tasks and sessions"
                rows={week.work}
                size={(w) => w.usage.inputTokens}
                rowKey={(w) => JSON.stringify([w.kind, w.task, w.repo, w.label])}
                render={(work) => <WorkRow work={work} />}
              />
              <RankedList
                title="Tools"
                rows={week.tools}
                size={(t) => t.resultTokens}
                rowKey={(t) => JSON.stringify([t.server, t.tool])}
                render={(tool) => <ToolRow tool={tool} />}
              />
            </div>
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

/** A number of the week's total, larger than the text around it. */
function Big({ children }: { children: ReactNode }) {
  return <span className="font-mono text-lg font-semibold">{children}</span>;
}

interface RankedListProps<T> {
  title: string;
  rows: readonly T[];
  /** What the list ranks by; each row's bar is its share of the first row's. */
  size: (row: T) => number;
  rowKey: (row: T) => string;
  render: (row: T) => ReactNode;
}

function RankedList<T>({ title, rows, size, rowKey, render }: RankedListProps<T>) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, TOP_ROWS);
  const largest = Math.max(0, ...rows.map(size));
  return (
    <div className="flex flex-col gap-2">
      <h3 className="hud-label">{title}</h3>
      <ol className="flex flex-col">
        {shown.map((row) => (
          <li key={rowKey(row)} className="flex min-w-0 flex-col gap-1.5 border-b py-2 last:border-b-0">
            <span className="flex min-w-0 items-baseline justify-between gap-3">{render(row)}</span>
            <span aria-hidden className="bg-secondary flex h-1 overflow-hidden rounded-full">
              <span className="bg-chart-1 rounded-full" style={{ width: `${rankShare(size(row), largest)}%` }} />
            </span>
          </li>
        ))}
      </ol>
      {rows.length > TOP_ROWS && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll((a) => !a)}>
          {all ? `Show the top ${TOP_ROWS}` : `Show all ${rows.length}`}
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
