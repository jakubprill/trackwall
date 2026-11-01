import { agentsApi, type JavaNavigationStatus, type Session, type Task } from "@trackwall/protocol";
import { useCallback } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { javaNavigationMark, javaNavigationPollMs } from "@/lib/java-navigation";
import { useRemote } from "@/lib/use-remote";

/** How a running task's Java language server is doing (ADR-124), in the task's header; nothing for a task without it. */
export function JavaNavigationMark({ conn, task, running }: { conn: Connection; task: Task; running: boolean }) {
  const load = useCallback(() => post(conn, agentsApi.taskJavaNavigation, { task: task.id }), [conn, task.id]);
  return <JavaNavigationStatusMark load={task.javaNavigation && running ? load : undefined} />;
}

/**
 * The same for a running main session (ADR-175), in its header: the daemon knows whether the session has Java
 * navigation and answers `null` when it does not, so the mark shows nothing.
 */
export function SessionJavaNavigationMark({ conn, session, running }: { conn: Connection; session: Session; running: boolean }) {
  const load = useCallback(() => post(conn, agentsApi.sessionJavaNavigation, { session: session.id }), [conn, session.id]);
  const asks = running && session.repo !== null && session.task === null && session.view === "terminal";
  return <JavaNavigationStatusMark load={asks ? load : undefined} />;
}

function JavaNavigationStatusMark({ load }: { load: (() => Promise<JavaNavigationStatus | null>) | undefined }) {
  const status = useRemote(load, { pollMs: javaNavigationPollMs });
  if (!status.data) return null;
  const mark = javaNavigationMark(status.data);
  return (
    <span className="shrink-0 text-xs" title={mark.title}>
      <StatusLabel tone={mark.tone} label={mark.label} />
    </span>
  );
}
