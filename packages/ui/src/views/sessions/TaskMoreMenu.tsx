import { mayHandToSupervisor, type PausedTask, type Task } from "@trackwall/protocol";
import { Ellipsis } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ModelChangeButton } from "@/components/ModelChange";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { CopyIncludedFilesButton, HandToSupervisorButton, PauseButton } from "./TaskButtons.tsx";

/**
 * What a task's header does less often than Verify, VS Code and Stop, behind one "More" button (ADR-272): Copy included
 * files, the model change, Hand to supervisor and Pause, each with its name, where the header had four icons to learn.
 * The menu lies over the panel under its button, so the terminal keeps its size. It closes on Escape, on a click
 * outside it and when an action is done; a failed action keeps it open with the error above its button. Hidden rather
 * than unmounted, so that an action still running when the menu closes shows its error when it opens again.
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
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const changed = () => {
    close();
    onChanged();
  };
  return (
    <MoreMenu label="More task actions" open={open} onOpen={setOpen}>
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
      {mayHandToSupervisor(task) && <HandToSupervisorButton conn={conn} task={task} disabled={confirmingRemoval} onHanded={changed} />}
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
    </MoreMenu>
  );
}

/** The "More" button and the menu under it: a column of buttons, as wide as its longest name. */
function MoreMenu({
  label,
  open,
  onOpen,
  children,
}: {
  label: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLFieldSetElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // In the capture phase, since a terminal under the menu keeps its pointer events to itself.
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open, onOpen]);
  return (
    <fieldset
      ref={root}
      aria-label={label}
      className="relative"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        onOpen(false);
        button.current?.focus();
      }}
    >
      <Button ref={button} variant="outline" size="sm" onClick={() => onOpen(!open)} aria-expanded={open} title={label}>
        <Ellipsis /> More
      </Button>
      <div
        hidden={!open}
        className="bg-overlay absolute top-full right-0 z-10 mt-1 flex w-max flex-col items-stretch gap-1 rounded-md border p-1 shadow-lg *:justify-start"
      >
        {children}
      </div>
    </fieldset>
  );
}
