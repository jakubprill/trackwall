import { taskEvidenceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type EvidenceSource, evidenceRows, taskEvidencePollMs } from "@/lib/task-evidence";
import { useRemote } from "@/lib/use-remote";

const SOURCE: Record<EvidenceSource, string> = {
  approval: "your approval",
  claim: "the agent's word",
  check: "checked by Trackwall",
  observed: "seen by Trackwall",
};

/**
 * The evidence card at the top of a task's Changes tab (ADR-276): what backs the diff below it, one row per fact with
 * whose word it is, read from the daemon's task evidence. It is read again when the diff changes, so a check that the
 * changes moved past shows as outdated at once, and while a check runs, so its verdict comes in without a click.
 */
export function TaskEvidenceCard({ conn, task, patch }: { conn: Connection; task: string; patch: string }) {
  const load = useCallback(() => post(conn, taskEvidenceApi.get, { task }), [conn, task]);
  const evidence = useRemote(load, { pollMs: taskEvidencePollMs, refreshKey: patch });
  if (!evidence.data) return evidence.error ? <p className="text-destructive text-xs">Evidence: {evidence.error}</p> : null;
  return (
    <section aria-label="Evidence" className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <span className="hud-label">Evidence</span>
        <span className="text-muted-foreground truncate text-xs">What backs this change, and whose word each fact is</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-4 gap-y-1">
        {evidenceRows(evidence.data).map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-muted-foreground text-xs">{row.label}</dt>
            <dd className="min-w-0 text-sm">
              <StatusLabel tone={row.tone} label={row.text} className="shrink" />
            </dd>
            <dd className="text-muted-foreground text-right text-xs">{row.source && SOURCE[row.source]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
