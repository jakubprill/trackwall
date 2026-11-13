import { agentsApi, type PausedTask, type Session, type Task, WORKTREE_INCLUDE_FILE } from "@trackwall/protocol";
import { FileInput, Forward, Pause, Play, Square } from "lucide-react";
import { EditorButton } from "@/components/EditorButton";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { PAUSE_TITLE } from "@/lib/task-pause";
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

/**
 * Pausing a task (ADR-251): its session, service, mise tasks, checks and shell stop, and only the user's Resume goes on.
 * The daemon waits until every process is gone, which takes a few seconds for one that ignores the gentle stop; the
 * error shows next to the button.
 */
export function PauseButton({
  conn,
  task,
  disabled = false,
  iconOnly = false,
  onPaused,
}: {
  conn: Connection;
  task: Task;
  disabled?: boolean;
  /** In the task panel's header, so its buttons stay on one row on a small screen and the terminal keeps its height. */
  iconOnly?: boolean;
  onPaused: (paused: PausedTask) => void;
}) {
  const pause = useAction(() => post(conn, agentsApi.pauseTask, { task: task.id }), onPaused);
  const label = pause.pending ? "Pausing…" : "Pause";
  return (
    <>
      {pause.error && <span className="text-destructive max-w-xs truncate text-xs">{pause.error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={pause.run}
        disabled={disabled || pause.pending}
        aria-label={iconOnly ? label : undefined}
        title={PAUSE_TITLE}
      >
        <Pause /> {!iconOnly && label}
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
export function CopyIncludedFilesButton({
  conn,
  task,
  iconOnly = false,
  onCopied,
}: {
  conn: Connection;
  task: Task;
  /** In the task panel's header, beside Pause, so its buttons stay on one row on a small screen. */
  iconOnly?: boolean;
  onCopied: () => void;
}) {
  const copy = useAction(() => post(conn, agentsApi.copyIncludedFilesAgain, { task: task.id }), onCopied);
  return (
    <>
      {copy.error && <span className="text-destructive max-w-xs truncate text-xs">{copy.error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={copy.run}
        disabled={copy.pending}
        aria-label={iconOnly ? "Copy included files" : undefined}
        title={`Copy included files: the files the repo's ${WORKTREE_INCLUDE_FILE} names, into the worktree again; files it already has stay as they are`}
      >
        <FileInput /> {!iconOnly && "Copy included files"}
      </Button>
    </>
  );
}

/**
 * Handing a task the user started to the supervisor (ADR-155): it then hears what the task does and may message its
 * agent, as for a task it proposed. The error shows next to the button.
 */
export function HandToSupervisorButton({
  conn,
  task,
  disabled,
  onHanded,
}: {
  conn: Connection;
  task: Task;
  disabled: boolean;
  onHanded: () => void;
}) {
  const hand = useAction(() => post(conn, agentsApi.handToSupervisor, { task: task.id }), onHanded);
  return (
    <>
      {hand.error && <span className="text-destructive max-w-xs truncate text-xs">{hand.error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={hand.run}
        disabled={disabled || hand.pending}
        // An icon only, so that the panel's buttons stay on one row on a small screen and leave the terminal its height.
        aria-label="Hand to supervisor"
        title="Hand to supervisor: it hears when this task finishes a turn, reports or fails, and may send its agent messages"
      >
        <Forward />
      </Button>
    </>
  );
}
