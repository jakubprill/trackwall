import type { DoctorCheck, DoctorReport, DoctorStatus } from "@trackwall/protocol";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Skeleton, Skeletons } from "@/components/Skeleton";
import { Steady } from "@/components/Steady";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { doctorCheckTitle, doctorHeadline, doctorProblemCount, doctorStatusLabel } from "@/lib/doctor";
import type { RemoteHandle } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

/**
 * The doctor (ADR-101): what Trackwall needs on this computer, checked when Settings shows it and on "Check again", each
 * problem with what to do about it. It only reads. The report is the one "Get started" shows as steps (ADR-262).
 */
export function DoctorSurface({ report }: { report: RemoteHandle<DoctorReport> }) {
  const problems = report.data && doctorProblemCount(report.data);
  const loading = !report.data && !report.error;
  return (
    <Surface label="Doctor" meta={problems ? String(problems) : undefined}>
      <Steady name="doctor" loading={loading} className="flex flex-col gap-3 p-4">
        {report.error && <ErrorWithRetry message={report.error} onRetry={report.reload} />}
        {loading && <DoctorPlaceholder />}
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
      </Steady>
    </Surface>
  );
}

/** As many checks as the doctor runs on a computer that is set up; each a title and a line of what was found. */
const PLACEHOLDER_CHECKS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];

/** The doctor's report while it is checked, which takes a few seconds: the same lines, without their text. */
function DoctorPlaceholder() {
  return (
    <Skeletons className="flex flex-col gap-3">
      <Skeleton className="h-5 w-64 max-w-full" />
      {PLACEHOLDER_CHECKS.map((key) => (
        <span key={key} className="flex flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
        </span>
      ))}
      <Skeleton className="h-8 w-28" />
    </Skeletons>
  );
}

const STATUS_CLASS: Record<DoctorStatus, string> = { ok: "text-success", warn: "text-warning", fail: "text-destructive" };

function CheckEntry({ check }: { check: DoctorCheck }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0">
      <span className="flex items-baseline gap-2 text-sm">
        <span className={cn("text-xs font-medium", STATUS_CLASS[check.status])}>{doctorStatusLabel(check.status)}</span>
        <span className="font-medium">{doctorCheckTitle(check.id)}</span>
      </span>
      <span className="text-muted-foreground text-xs break-words">{check.summary}</span>
      {check.fix && <span className="text-xs break-words">{check.fix}</span>}
    </li>
  );
}
