import { agentsApi, type Session, type Task, WORKTREE_INCLUDE_FILE } from "@trackwall/protocol";
import { FileInput, Play, Square } from "lucide-react";
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

/**
 * Copying what the repo root's `.worktreeinclude` names into the task's worktree again (ADR-61), for a line added after
 * the task started; the "Included files" section then lists what the worktree got. The error shows next to the button.
 */
export function CopyIncludedFilesButton({ conn, task, onCopied }: { conn: Connection; task: Task; onCopied: () => void }) {
  const copy = useAction(() => post(conn, agentsApi.copyIncludedFilesAgain, { task: task.id }), onCopied);
  return (
    <>
      {copy.error && <span className="text-destructive max-w-xs truncate text-xs">{copy.error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={copy.run}
        disabled={copy.pending}
        title={`Copy the files the repo's ${WORKTREE_INCLUDE_FILE} names into the worktree again; files it already has stay as they are`}
      >
        <FileInput /> Copy included files
      </Button>
    </>
  );
}
