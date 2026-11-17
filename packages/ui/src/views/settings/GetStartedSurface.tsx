import type { DoctorReport, WorkspaceSettings } from "@trackwall/protocol";
import { useContext } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { DaemonPlaceContext } from "@/lib/desktop";
import { getStartedHeadline, getStartedPlace, getStartedPlan } from "@/lib/get-started";
import type { RemoteHandle } from "@/lib/use-remote";
import { GetStartedSteps } from "./GetStartedSteps.tsx";
import { ProjectsFolderForm } from "./ProjectsFolderForm.tsx";

/**
 * "Get started" (ADR-262): what is left before a first session, from the doctor's report, with the projects folder set
 * right here. The report is the one Settings or Home already runs, handed in, so the number next to the category and
 * this list come from the same run.
 */
export function GetStartedSurface({
  conn,
  report,
  settings,
  onRetry,
  onStart,
  onOpenDiagnostics,
}: {
  conn: Connection;
  report: RemoteHandle<DoctorReport>;
  /** The workspace settings Settings already read, for the form of the projects folder. */
  settings: RemoteHandle<WorkspaceSettings>;
  /** Reconnects to the daemon, for a read that failed because the daemon is gone. */
  onRetry: () => void;
  /** Shows where sessions start, once nothing needed is left. */
  onStart: () => void;
  onOpenDiagnostics: () => void;
}) {
  const place = getStartedPlace(useContext(DaemonPlaceContext));
  const plan = report.data && getStartedPlan(report.data);
  return (
    <div className="flex flex-col gap-4">
      {report.error && <ErrorWithRetry message={report.error} onRetry={report.reload} />}
      {!report.data && !report.error && <Loading />}
      {plan && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              {getStartedHeadline(plan)} <span className="text-muted-foreground">Trackwall runs {place}.</span>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={report.reload}>
                Check again
              </Button>
              {plan.ready && (
                <Button size="sm" onClick={onStart}>
                  Start a session
                </Button>
              )}
            </div>
          </div>
          <GetStartedSteps
            plan={plan}
            action={(step) =>
              step.id === "projects-folder" && step.state === "todo" ? (
                <ProjectsFolderForm conn={conn} settings={settings} onRetry={onRetry} onSaved={report.reload} />
              ) : null
            }
          />
          {plan.otherProblems > 0 && (
            <p className="text-muted-foreground text-xs">
              The doctor has more to say that does not stop a session.{" "}
              <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={onOpenDiagnostics}>
                Open Diagnostics
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
