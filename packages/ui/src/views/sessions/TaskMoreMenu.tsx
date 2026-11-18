import { mayHandToSupervisor, type PausedTask, type Task } from "@trackwall/protocol";
import { ModelChangeButton } from "@/components/ModelChange";
import { MoreMenu } from "@/components/MoreMenu";
import type { Connection } from "@/lib/connection";
import { CopyIncludedFilesButton, HandToSupervisorButton, PauseButton } from "./TaskButtons.tsx";

/**
 * What a task's header does less often than Verify, VS Code and Stop, behind one "More" button (ADR-272): Copy included
 * files, the model change, Hand to supervisor and Pause, each with its name, where the header had four icons to learn.
 * The menu (`MoreMenu`) lies over the panel, so the terminal keeps its size, and closes when an action is done; a
 * failed action keeps it open with the error above its button.
 */
export function TaskMoreMenu({
  conn,
  task,
  removing,
  confirmingRemoval,
  modelChange,
  onChanged,
  onPaused,
}: {
  conn: Connection;
  task: Task;
  /** The user asked to end the task: no pause and no other model for a task on its way out. */
  removing: boolean;
  /** The end of the task waits for a confirmation, with nothing running. */
  confirmingRemoval: boolean;
  /** The strip under the header that changes the model: whether it is open, what its button says and its toggle. */
  modelChange: { open: boolean; title: string; onToggle: () => void };
  onChanged: () => void;
  onPaused: (paused: PausedTask) => void;
}) {
  return (
    <MoreMenu label="More task actions">
      {(close) => {
        const changed = () => {
          close();
          onChanged();
        };
        return (
          <>
            <CopyIncludedFilesButton conn={conn} task={task} onCopied={changed} />
            <ModelChangeButton
              open={modelChange.open}
              onToggle={() => {
                close();
                modelChange.onToggle();
              }}
              disabled={removing}
              title={modelChange.title}
              label="Change model"
            />
            {mayHandToSupervisor(task) && (
              <HandToSupervisorButton conn={conn} task={task} disabled={confirmingRemoval} onHanded={changed} />
            )}
            {task.paused === null && (
              <PauseButton
                conn={conn}
                task={task}
                disabled={removing}
                onPaused={(paused) => {
                  close();
                  onPaused(paused);
                }}
              />
            )}
          </>
        );
      }}
    </MoreMenu>
  );
}
