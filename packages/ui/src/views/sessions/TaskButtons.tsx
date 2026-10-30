import { agentsApi, type Session, type Task } from "@trackwall/protocol";
import { Play, Square } from "lucide-react";
import { EditorButton } from "@/components/EditorButton";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/** Stopping the task's running session, in its panel and its grid tile; the error shows next to the button. */
export function StopButton({ conn, session, onStopped }: { conn: Connection; session: Session; onStopped: () => void }) {
  const stop = useAction(() => post(conn, agentsApi.stop, { session: session.id }), onStopped);
  return (
    <>
      {stop.error && <span className="text-destructive max-w-xs truncate text-xs">{stop.error}</span>}
      <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending || session.run.kind === "stopping"}>
        <Square /> Stop
      </Button>
    </>
  );
}

/** Resuming a task without a running session in a new one (ADR-90); the error shows next to the button. */
export function ResumeButton({
  conn,
  task,
  disabled = false,
  onResumed,
}: {
  conn: Connection;
  task: Task;
  disabled?: boolean;
  onResumed: () => void;
}) {
  const resume = useAction(() => post(conn, agentsApi.resumeTask, { task: task.id }), onResumed);
  return (
    <>
      {resume.error && <span className="text-destructive max-w-xs truncate text-xs">{resume.error}</span>}
      <Button variant="outline" size="sm" onClick={resume.run} disabled={disabled || resume.pending}>
        <Play /> Resume
      </Button>
    </>
  );
}

/** Opening the task's worktree in VS Code (`EditorButton`); the error shows next to the button. */
export function TaskEditorButton({ conn, task, label }: { conn: Connection; task: Task; label: string }) {
  const openEditor = useAction(
    () => post(conn, agentsApi.openTaskEditor, { task: task.id }),
    () => {},
  );
  return (
    <>
      {openEditor.error && <span className="text-destructive max-w-xs truncate text-xs">{openEditor.error}</span>}
      <EditorButton path={task.worktree} label={label} onOpen={openEditor.run} disabled={openEditor.pending} />
    </>
  );
}
