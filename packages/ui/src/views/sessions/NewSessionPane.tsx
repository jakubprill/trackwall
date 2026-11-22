import type { Session, WorkspaceSettings } from "@trackwall/protocol";
import { useContext, useState } from "react";
import { getStartedStepAction } from "@/components/GetStartedSteps";
import type { Connection } from "@/lib/connection";
import { DaemonPlaceContext } from "@/lib/desktop";
import { getStartedInSessions, getStartedPlace, getStartedPlan } from "@/lib/get-started";
import { readOpenSteps, useOpenSteps } from "@/lib/get-started-memory";
import type { SessionSelection } from "@/lib/session-entries";
import { useDoctorReport } from "@/lib/use-doctor-report";
import type { RemoteHandle } from "@/lib/use-remote";
import { GetStartedCard } from "./GetStartedCard.tsx";
import { NewSession } from "./NewSession.tsx";
import { RoutineList } from "./RoutineList.tsx";
import { WorktreeCleanup } from "./WorktreeCleanup.tsx";

/**
 * The Sessions view while no entry is selected: the form for a new task or session, the routines under it and the
 * cleanup of old worktrees, and above them, while setup is under way, what is left before a first session (ADR-289).
 * Before a projects folder is set the card is all it shows, since every start and the reads of the templates and
 * routines need the folder; the card's first step sets it, and the form shows under it at once.
 */
export function NewSessionPane({
  conn,
  sessions,
  workspace,
  onStarted,
  onCancel,
  onWorktreesRemoved,
  onRetry,
  onOpenGetStarted,
}: {
  conn: Connection;
  sessions: readonly Session[];
  /** The window's read of the workspace settings, whose projects folder decides what the pane offers. */
  workspace: RemoteHandle<WorkspaceSettings>;
  onStarted: (selection: SessionSelection) => void;
  /** Back to the entry selected before; none while the list is empty. */
  onCancel?: () => void;
  onWorktreesRemoved: () => void;
  /** Reconnects to the daemon, for a read that failed because the daemon is gone. */
  onRetry: () => void;
  /** Opens Settings › Get started, with every step and what is good to have. */
  onOpenGetStarted: () => void;
}) {
  const projectsDir = workspace.data?.projectsDir;
  // Until the window's first read of the settings the pane cannot tell whether a folder is set, and a form shown meanwhile
  // asks a new install for routines it cannot have; a failed read keeps the form, whose own reads say what is wrong.
  const offersForm = projectsDir !== null && (workspace.data !== undefined || workspace.error !== undefined);
  const check = useGetStartedCheck(conn, projectsDir, sessions.length);
  const place = getStartedPlace(useContext(DaemonPlaceContext));
  return (
    <div className="min-h-0 overflow-y-auto">
      {check && (
        <GetStartedCard
          plan={check.data && getStartedPlan(check.data)}
          error={check.error}
          place={place}
          action={(step) => getStartedStepAction(step, { conn, settings: workspace, onRetry, onChanged: check.reload })}
          onCheckAgain={check.reload}
          onOpenGetStarted={onOpenGetStarted}
        />
      )}
      {offersForm && (
        <>
          <NewSession conn={conn} sessions={sessions} onStarted={onStarted} onCancel={onCancel} />
          <RoutineList conn={conn} onStarted={onStarted} />
          <WorktreeCleanup conn={conn} onRemoved={onWorktreesRemoved} />
        </>
      )}
    </div>
  );
}

/**
 * The doctor's run the card above the form shows, or `undefined` while it does not show: from the moment
 * `getStartedInSessions` asks for it until the pane goes, so that the card stays through the steps it settles itself (the
 * folder it saves would otherwise take it away at once) and says "Ready" at their end. The run's count of open steps is
 * kept for the next time and for Settings (ADR-268).
 */
function useGetStartedCheck(conn: Connection, projectsDir: string | null | undefined, sessionCount: number) {
  const [shown, setShown] = useState(false);
  if (
    !shown &&
    getStartedInSessions(
      projectsDir,
      sessionCount,
      readOpenSteps(() => window.localStorage),
    )
  )
    setShown(true);
  const report = useDoctorReport(conn, shown);
  useOpenSteps(report.data);
  return shown ? report : undefined;
}
