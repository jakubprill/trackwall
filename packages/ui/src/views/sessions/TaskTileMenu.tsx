import { type Session, TASK_PORT_ENV, type Task } from "@trackwall/protocol";
import { Ellipsis, FileDiff, ListTree, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { isLive } from "@/lib/session-state";
import type { TaskVerificationState } from "@/lib/use-task-verification";
import type { TileOverlay as TileOverlayState } from "@/lib/use-tile-overlay";
import { ResumeButton, StopButton, TaskEditorButton } from "./TaskButtons.tsx";
import { VerifyButton } from "./TaskVerification.tsx";
import { TileOverlay } from "./TileOverlay.tsx";

/**
 * The task menu of a grid tile (ADR-91): behind one button in the tile's header, so that six tiles keep their header on
 * one line, what the task panel's header has: branch, task port, model, no approvals and start, and VS Code, Verify,
 * Stop or Resume. "Changes" opens the task alone on its changes, "Details" the task's sections over the terminal.
 * It lies over the terminal like the other overlays, so that the terminal keeps its size, and is one of the tile's
 * `overlay`, so that opening it closes the task's notices and back. While the task is being ended there is no menu.
 */
export function useTaskTileMenu({
  conn,
  task,
  session,
  verification,
  overlay,
  onOpenChanges,
  onChanged,
}: {
  conn: Connection;
  task: Task | undefined;
  session: Session | undefined;
  verification: TaskVerificationState;
  overlay: TileOverlayState;
  onOpenChanges: () => void;
  onChanged: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const open = overlay.opened?.kind === "menu";
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  if (!task) return { button: null, overlay: null };
  const liveSession = session && isLive(session) ? session : undefined;

  return {
    button: (
      <Button
        ref={overlay.trigger({ kind: "menu" })}
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={() => (open ? overlay.close() : overlay.open({ kind: "menu" }))}
        aria-expanded={open}
        aria-label="Task menu"
      >
        <Ellipsis />
      </Button>
    ),
    overlay: (
      <TileOverlay
        ref={panel}
        open={open}
        label="Task menu"
        onEscape={overlay.close}
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
          <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={overlay.close} aria-label="Close the task menu">
            <X />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 p-2">
          <TaskEditorButton conn={conn} task={task} label="VS Code" />
          <VerifyButton state={verification} disabled={false} />
          <Button variant="outline" size="sm" onClick={onOpenChanges}>
            <FileDiff /> Changes
          </Button>
          <Button variant="outline" size="sm" onClick={() => overlay.open({ kind: "notices" })}>
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
