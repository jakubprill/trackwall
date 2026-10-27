import type { RunningMiseTask, Session, Task, TaskMessage } from "@trackwall/protocol";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { newWarnings } from "@/lib/task-notices";
import { useTaskDetails } from "@/lib/use-task-details";
import { scrollToSection, TaskDetails } from "./TaskDetails.tsx";
import { NoticeBadge, NoticeChips } from "./TaskNotices.tsx";

/** Where a grid tile puts its notices: the badge in its header and the overlay or banner over its body. */
export interface TileNotices {
  badge: ReactNode;
  overlay: ReactNode;
}

/**
 * A task's notices on a grid tile (ADR-91): a badge in the tile's header opens the task's sections as an overlay
 * over the terminal, so that the terminal keeps its size, and a warning that shows up while the grid is open lies
 * over the terminal as one line until the user opens or closes it. Warnings the task had when the tile appeared count
 * as seen: the badge already says them.
 */
export function TaskTileNotices({
  conn,
  task,
  tasks,
  messages,
  sessions,
  runningLive,
  onOpenTask,
  children,
}: {
  conn: Connection;
  task: Task;
  tasks: readonly Task[];
  messages: readonly TaskMessage[];
  sessions: readonly Session[];
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  onOpenTask: (id: string) => void;
  children: (notices: TileNotices) => ReactNode;
}) {
  const details = useTaskDetails({ conn, task, tasks, messages, runningLive, paused: false });
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string>>();
  const overlay = useRef<HTMLElement>(null);
  const warningKeys = details.notices.filter((n) => n.tone === "warning").map((n) => n.key);
  if (seen === undefined && details.warningsChecked) setSeen(new Set(warningKeys));
  const unseen = seen ? newWarnings(details.notices, seen) : [];
  const markSeen = () => setSeen(new Set([...(seen ?? []), ...warningKeys]));
  const show = () => {
    markSeen();
    setOpen(true);
  };
  // Warnings that came while the overlay was open have been read there.
  const close = () => {
    markSeen();
    setOpen(false);
  };
  useEffect(() => {
    if (open) overlay.current?.focus();
  }, [open]);

  return children({
    badge: <NoticeBadge notices={details.notices} open={open} onToggle={open ? close : show} />,
    overlay: open ? (
      <section
        ref={overlay}
        tabIndex={-1}
        aria-label="Task notices overlay"
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
        className="bg-card absolute inset-x-1 top-1 z-10 flex max-h-2/3 flex-col overflow-hidden rounded-md border shadow-lg outline-none"
      >
        <div className="flex items-center gap-2 border-b px-2 py-1">
          <NoticeChips notices={details.notices} onOpen={(section) => scrollToSection(overlay.current, section)} />
          <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={close} aria-label="Close task notices">
            <X />
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          <TaskDetails conn={conn} task={task} details={details} messages={messages} sessions={sessions} onOpenTask={onOpenTask} />
        </div>
      </section>
    ) : unseen.length > 0 ? (
      <div
        role="status"
        className="bg-card border-warning/50 text-warning absolute inset-x-1 top-1 z-10 flex items-center gap-2 rounded-md border px-2 py-1 text-xs shadow-lg"
      >
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
      </div>
    ) : null,
  });
}
