import { type Session, TASK_PORT_ENV, type Task } from "@trackwall/protocol";
import { Ellipsis, FileDiff, ListTree, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { isLive } from "@/lib/session-state";
import type { TaskVerificationState } from "@/lib/use-task-verification";
import { ResumeButton, StopButton, TaskEditorButton } from "./TaskButtons.tsx";
import { VerifyButton } from "./TaskVerification.tsx";
import { TileOverlay } from "./TileOverlay.tsx";

/**
 * The task menu of a grid tile (ADR-91): behind one button in the tile's header, so that six tiles keep their header on
 * one line, what the task panel's header has: branch, task port, model, no approvals and start, and VS Code, Verify,
 * Stop or Resume. "Changes" opens the task alone on its changes, "Details" the task's sections over the terminal.
 * It lies over the terminal like the other overlays, so that the terminal keeps its size.
 */
export function useTaskTileMenu({
  conn,
  task,
  session,
  verification,
  onOpenChanges,
  onOpenDetails,
  onChanged,
}: {
  conn: Connection;
  task: Task | undefined;
  session: Session | undefined;
  verification: TaskVerificationState;
  onOpenChanges: () => void;
  onOpenDetails: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const overlay = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) overlay.current?.focus();
  }, [open]);
  if (!task) return { button: null, overlay: null };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const liveSession = session && isLive(session) ? session : undefined;

  return {
    button: (
      <Button
        ref={button}
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-label="Task menu"
      >
        <Ellipsis />
      </Button>
    ),
    overlay: (
      <TileOverlay
        ref={overlay}
        open={open}
        label="Task menu"
        onEscape={close}
        className="left-auto w-80 max-w-[calc(100%-0.5rem)] text-xs"
      >
        <div className="flex items-start gap-2 border-b px-2 py-1.5">
          <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <MenuFact name="branch" value={task.branch} />
            <MenuFact name="port" value={String(task.port)} title={`task port: ${TASK_PORT_ENV.join(" and ")} of its mise tasks`} />
            {task.model !== null && <MenuFact name="model" value={task.model} />}
            {task.approvals === "auto" && <MenuFact name="approvals" value="none asked" />}
            <MenuFact name="started" value={relativeTime(session?.startedAt ?? task.createdAt, new Date())} />
          </dl>
          <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={close} aria-label="Close the task menu">
            <X />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 p-2">
          <TaskEditorButton conn={conn} task={task} label="VS Code" />
          <VerifyButton state={verification} disabled={false} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false);
              onOpenChanges();
            }}
          >
            <FileDiff /> Changes
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false);
              onOpenDetails();
            }}
          >
            <ListTree /> Details
          </Button>
          {liveSession ? (
            <StopButton conn={conn} session={liveSession} onStopped={onChanged} />
          ) : (
            <ResumeButton conn={conn} task={task} onResumed={onChanged} />
          )}
        </div>
      </TileOverlay>
    ),
  };
}

function MenuFact({ name, value, title }: { name: string; value: string; title?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="truncate font-mono" title={title ?? value}>
        {value}
      </dd>
    </>
  );
}
