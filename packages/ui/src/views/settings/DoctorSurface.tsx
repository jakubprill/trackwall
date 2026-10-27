import { type DoctorCheck, doctorApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { doctorEntry, doctorHeadline } from "@/lib/doctor";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

/**
 * The doctor (ADR-101): what Trackwall needs on this computer, checked when Settings opens and on "Check again", each
 * problem with what to do about it. It only reads.
 */
export function DoctorSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, doctorApi.run, {}), [conn]);
  const report = useRemote(load);
  const problems = report.data?.checks.filter((c) => c.status !== "ok").length;
  return (
    <Surface label="Doctor" meta={problems ? String(problems) : undefined}>
      <div className="flex flex-col gap-3 p-4">
        {report.error && <ErrorWithRetry message={report.error} onRetry={report.reload} />}
        {!report.data && !report.error && <Loading />}
        {report.data && (
          <>
            <p className="text-sm">{doctorHeadline(report.data)}</p>
            <ul className="flex flex-col gap-3">
              {report.data.checks.map((check) => (
                <CheckEntry key={check.id} check={check} />
              ))}
            </ul>
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={report.reload}>
                Check again
              </Button>
              <span className="text-muted-foreground text-xs">Checked at {new Date(report.data.checkedAt).toLocaleTimeString()}</span>
            </div>
          </>
        )}
      </div>
    </Surface>
  );
}

const STATUS_CLASS: Record<DoctorCheck["status"], string> = { ok: "text-success", warn: "text-warning", fail: "text-destructive" };

function CheckEntry({ check }: { check: DoctorCheck }) {
  const entry = doctorEntry(check);
  return (
    <li className="flex min-w-0 flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0">
      <span className="flex items-baseline gap-2 text-sm">
        <span className={cn("text-xs font-medium", STATUS_CLASS[check.status])}>{entry.status}</span>
        <span className="font-medium">{entry.title}</span>
      </span>
      <span className="text-muted-foreground text-xs break-words">{entry.summary}</span>
      {entry.fix && <span className="text-xs break-words">{entry.fix}</span>}
    </li>
  );
}
