import type { Session } from "@trackwall/protocol";
import { ProjectsFolderNeeded } from "@/components/ProjectsFolderNeeded";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { NewSession } from "./NewSession.tsx";
import { RoutineList } from "./RoutineList.tsx";
import { WorktreeCleanup } from "./WorktreeCleanup.tsx";

/**
 * The Sessions view while no entry is selected: the form for a new task or session, the routines under it and the
 * cleanup of old worktrees. Before a projects folder is set it offers none of them, since every start and the reads of
 * the templates and routines need the folder: it says so, with "Get started" (ADR-262).
 */
export function NewSessionPane({
  conn,
  sessions,
  projectsDir,
  onStarted,
  onCancel,
  onWorktreesRemoved,
  onOpenGetStarted,
}: {
  conn: Connection;
  sessions: readonly Session[];
  /** `null` while none is set, `undefined` while the settings are on their way, which keeps the form. */
  projectsDir: string | null | undefined;
  onStarted: (selection: SessionSelection) => void;
  /** Back to the entry selected before; none while the list is empty. */
  onCancel?: () => void;
  onWorktreesRemoved: () => void;
  /** Opens Settings › Get started, where the projects folder is set. */
  onOpenGetStarted: () => void;
}) {
  if (projectsDir === null) return <ProjectsFolderNeeded needs="start a task or session" onOpenGetStarted={onOpenGetStarted} />;
  return (
    <div className="min-h-0 overflow-y-auto">
      <NewSession conn={conn} sessions={sessions} onStarted={onStarted} onCancel={onCancel} />
      <RoutineList conn={conn} onStarted={onStarted} />
      <WorktreeCleanup conn={conn} onRemoved={onWorktreesRemoved} />
    </div>
  );
}
