import type { RunningMiseTask, Session, Task, TaskMessage } from "@trackwall/protocol";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { newWarnings } from "@/lib/task-notices";
import { useTaskDetails } from "@/lib/use-task-details";
import { cn } from "@/lib/utils";
import { scrollToSection, TaskDetails } from "./TaskDetails.tsx";
import { NoticeBadge, NoticeChips } from "./TaskNotices.tsx";
import { TileOverlay } from "./TileOverlay.tsx";

/** A selected tile checks its warnings as often as the task panel, the others less often: each check reads git. */
const UNSELECTED_WARNING_POLL_MS = 15_000;

/**
 * A task's notices on a grid tile (ADR-91): a badge in the tile's header opens the task's sections as an overlay
 * over the terminal, so that the terminal keeps its size, and a warning that shows up while the grid is open lies
 * over the terminal as one line until the user opens or closes it. Warnings the task had when the tile appeared count
 * as seen: the badge already says them. Without a task (a session in a repo root, task proposals) there is neither.
 */
export function useTaskTileNotices({
  conn,
  task,
  tasks,
  messages,
  sessions,
  runningLive,
  selected,
  paused,
  onOpenTask,
}: {
  conn: Connection;
  task: Task | undefined;
  tasks: readonly Task[];
  /** The messages the task's proposer sent its session (ADR-68), oldest first. */
  messages: readonly TaskMessage[];
  sessions: readonly Session[];
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  selected: boolean;
  /** While the task is being ended, nothing is loaded. */
  paused: boolean;
  onOpenTask: (id: string) => void;
}) {
  const details = useTaskDetails({
    conn,
    task,
    tasks,
    messages,
    runningLive,
    paused,
    warningPollMs: selected ? undefined : UNSELECTED_WARNING_POLL_MS,
  });
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string>>();
  const overlay = useRef<HTMLElement>(null);
  const badge = useRef<HTMLButtonElement>(null);
  const warningKeys = details.notices.filter((n) => n.tone === "warning").map((n) => n.key);
  if (seen === undefined && details.warningsChecked) setSeen(new Set(warningKeys));
  const unseen = seen ? newWarnings(details.notices, seen) : [];
  const markSeen = () => setSeen(new Set([...(seen ?? []), ...warningKeys]));
  const show = () => {
    markSeen();
    setOpen(true);
  };
  // Warnings that came while the overlay was open have been read there; the keyboard goes back to the badge.
  const close = () => {
    markSeen();
    setOpen(false);
    badge.current?.focus();
  };
  useEffect(() => {
    if (open) overlay.current?.focus();
  }, [open]);
  if (!task) return { badge: null, overlay: null };

  return {
    badge: <NoticeBadge ref={badge} notices={details.notices} open={open} onToggle={open ? close : show} />,
    // Hidden rather than unmounted when closed, so that a section keeps what the user did in it (the mise config shown
    // for trust, an open log). The close question comes later in the tile and lies over the notices; a new warning lies
    // over every overlay, the environment card too, so that it is never hidden behind one.
    overlay: (
      <>
        <TileOverlay ref={overlay} open={open} label="Task notices overlay" onEscape={close}>
          <div className="flex items-center gap-2 border-b px-2 py-1">
            <NoticeChips notices={details.notices} onOpen={(section) => scrollToSection(overlay.current, section)} />
            <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={close} aria-label="Close task notices">
              <X />
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto">
            <TaskDetails conn={conn} task={task} details={details} sessions={sessions} onOpenTask={onOpenTask} />
          </div>
        </TileOverlay>
        {/* Mounted while the tile is, so that a screen reader announces the warning when its text comes. */}
        <div
          role="status"
          className={cn(
            !open && unseen.length > 0
              ? "bg-card border-warning/50 text-warning absolute inset-x-1 top-1 z-20 flex items-center gap-2 rounded-md border px-2 py-1 text-xs shadow-lg"
              : "sr-only",
          )}
        >
          {!open && unseen.length > 0 && (
            <>
              <span className="min-w-0 flex-1 truncate">
                {unseen[0]?.label}
                {unseen.length > 1 && ` and ${unseen.length - 1} more`}
              </span>
              <Button variant="outline" size="sm" className="h-6 shrink-0" onClick={show}>
                Show
              </Button>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={markSeen} aria-label="Dismiss the warning">
                <X />
              </Button>
            </>
          )}
        </div>
      </>
    ),
  };
}
