import type { Session, Task } from "@trackwall/protocol";
import { SessionStateLabel } from "@/components/SessionStateLabel";
import { StatusLabel } from "@/components/StatusLabel";
import { taskStateLabel } from "@/lib/session-state";

/**
 * A task's state wherever a task is listed: "paused" for a task the user paused (ADR-251), otherwise its session's state
 * with its waiting time (`SessionStateLabel`), or "no session".
 */
export function TaskStateLabel({ task, session, labelClassName }: { task: Task; session: Session | undefined; labelClassName?: string }) {
  if (task.paused === null && session) return <SessionStateLabel session={session} labelClassName={labelClassName} />;
  return <StatusLabel {...taskStateLabel(task, session)} labelClassName={labelClassName} />;
}
