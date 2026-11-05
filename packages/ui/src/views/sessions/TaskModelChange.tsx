import { agentsApi, type Session, type Task } from "@trackwall/protocol";
import { ModelChangeStrip, SessionModelChange } from "@/components/ModelChange";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";

/**
 * Another model for a task (ADR-206): its running session restarts on it, and a task without one resumes on it. Either
 * way the task keeps the model, so a task stuck on a model its provider does not serve gets out of it.
 */
export function TaskModelChange({
  conn,
  task,
  liveSession,
  onDone,
  onCancel,
}: {
  conn: Connection;
  task: Task;
  liveSession: Session | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  if (liveSession) return <SessionModelChange conn={conn} session={liveSession} onDone={onDone} onCancel={onCancel} />;
  return (
    <ModelChangeStrip
      conn={conn}
      current={task.model}
      verb="Resume"
      note="The task goes on with its conversation on this model and keeps it for its later resumes."
      apply={(model) => post(conn, agentsApi.resumeTask, { task: task.id, model })}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
