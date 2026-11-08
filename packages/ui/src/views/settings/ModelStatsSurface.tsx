import { type CopilotUsage, ModelStatsPeriod, type ModelStatsRow, taskJournalApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { usageLabel } from "@/lib/copilot-usage";
import {
  fewTasks,
  MODEL_STATS_PERIOD_LABELS,
  perTask,
  perTaskDetails,
  perVerifiedTask,
  perVerifiedTaskDetails,
  rowNotes,
  share,
  verdict,
  withoutModelNote,
} from "@/lib/model-stats";
import { useRemote } from "@/lib/use-remote";

const COLUMNS = ["Model", "Tasks", "Verified", "Failed", "With commits", "Per task", "Per verified task"];

/**
 * Model statistics (ADR-231) in Settings › Usage: the ended tasks of the task journal by the model Copilot CLI ran them
 * on, how often they passed verification and what one cost, so the user can pick the model for the next task from their
 * own work. Read on opening, on a period change and on "Refresh".
 */
export function ModelStatsSurface({ conn }: { conn: Connection }) {
  const [period, setPeriod] = useState<ModelStatsPeriod>("30d");
  const load = useCallback(() => post(conn, taskJournalApi.modelStats, { period }), [conn, period]);
  const remote = useRemote(load);
  const stats = remote.data;
  const answer = stats ? verdict(stats) : null;
  const note = stats ? withoutModelNote(stats) : null;
  return (
    <Surface label="Models">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          The tasks you ended, by the model Copilot CLI ran them on: how often their last verification passed and what one cost. A task
          counts for the model that made most of its calls.
        </p>
        <div className="flex items-center gap-2">
          {ModelStatsPeriod.options.map((p) => (
            <Button
              key={p}
              variant={p === period ? "secondary" : "outline"}
              size="sm"
              aria-pressed={p === period}
              onClick={() => setPeriod(p)}
            >
              {MODEL_STATS_PERIOD_LABELS[p]}
            </Button>
          ))}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={remote.reload}>
            Refresh
          </Button>
        </div>
        {remote.error && <ErrorWithRetry message={remote.error} onRetry={remote.reload} />}
        {!stats && !remote.error && <Loading />}
        {stats && stats.models.length === 0 && <p className="text-sm">No ended task with a recorded model in this period.</p>}
        {answer && <p className="text-sm">{answer}</p>}
        {stats && stats.models.length > 0 && (
          <section aria-label="Models" className="overflow-auto rounded-md border">
            <table className="w-full text-left text-xs">
              <thead className="bg-card">
                <tr className="border-b">
                  {COLUMNS.map((h) => (
                    <th key={h} scope="col" className="hud-label px-2 py-1.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.models.map((row) => (
                  <ModelRow key={row.model} row={row} />
                ))}
              </tbody>
            </table>
          </section>
        )}
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
      </div>
    </Surface>
  );
}

function ModelRow({ row }: { row: ModelStatsRow }) {
  const notes = rowNotes(row);
  const few = fewTasks(row);
  return (
    <tr className="border-b align-top last:border-b-0">
      <td className="px-2 py-1.5">
        <span className="flex flex-col">
          <span className="font-mono whitespace-nowrap">{row.model}</span>
          {few && <span className="text-muted-foreground">too few tasks to compare</span>}
          {notes.map((n) => (
            <span key={n} className="text-muted-foreground">
              {n}
            </span>
          ))}
        </span>
      </td>
      <td className="px-2 py-1.5">{row.tasks}</td>
      <td className="px-2 py-1.5 whitespace-nowrap">{share(row.verified, row.tasks)}</td>
      <td className="px-2 py-1.5 whitespace-nowrap">{share(row.failed, row.tasks)}</td>
      <td className="px-2 py-1.5 whitespace-nowrap">{share(row.withCommits, row.tasks)}</td>
      <UsageCell usage={perTask(row)} title={perTaskDetails(row)} />
      <UsageCell usage={perVerifiedTask(row)} title={perVerifiedTaskDetails(row)} />
    </tr>
  );
}

function UsageCell({ usage, title }: { usage: CopilotUsage | null; title: string }) {
  return (
    <td className="text-muted-foreground px-2 py-1.5 font-mono whitespace-nowrap" title={usage ? title : undefined}>
      {usage ? usageLabel(usage) : "–"}
    </td>
  );
}
