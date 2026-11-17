import { readyForReview, type Session, type Task } from "@trackwall/protocol";
import { SessionStateLabel } from "@/components/SessionStateLabel";
import { StatusLabel } from "@/components/StatusLabel";
import { taskStateLabel } from "@/lib/session-state";

/**
 * A task's state wherever a task is listed: "Paused" for a task the user paused (ADR-253), "Ready for review" for one
 * handed over (ADR-261), otherwise its session's state with its waiting time (`SessionStateLabel`), or "No session".
 */
export function TaskStateLabel({ task, session, labelClassName }: { task: Task; session: Session | undefined; labelClassName?: string }) {
  if (task.paused === null && session && !readyForReview(task, session))
    return <SessionStateLabel session={session} labelClassName={labelClassName} />;
  return <StatusLabel {...taskStateLabel(task, session)} labelClassName={labelClassName} />;
}
