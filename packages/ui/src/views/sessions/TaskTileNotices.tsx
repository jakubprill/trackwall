import type { RunningMiseTask, Session, Task, TaskMessage } from "@trackwall/protocol";
import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { newWarnings, type TaskNotice, tileNotices } from "@/lib/task-notices";
import { useTaskDetails } from "@/lib/use-task-details";
import type { TileOverlay as TileOverlayState } from "@/lib/use-tile-overlay";
import { cn } from "@/lib/utils";
import { TaskEditorButton } from "./TaskButtons.tsx";
import { scrollToSection, TaskDetails } from "./TaskDetails.tsx";
import { NoticeBadge, NoticeChips, TileNoticeChip } from "./TaskNotices.tsx";
import { TileOverlay } from "./TileOverlay.tsx";

/** A selected tile checks its warnings as often as the task panel, the others less often: each check reads git. */
const UNSELECTED_WARNING_POLL_MS = 15_000;

/**
 * A task's notices on a grid tile (ADR-91): in the tile's header a chip of its own for the mise config while mise tasks
 * wait for the user's trust and for the verification, and a badge for the rest (`tileNotices`). The badge and the
 * verification chip open the task's sections over the terminal, so that the terminal keeps its size; the mise chip
 * opens the same overlay with only the mise config, with Trust and VS Code. A warning that shows up while the grid is
 * open lies over the terminal as one line until the user opens or closes it. Warnings the task had when the tile
 * appeared count as seen: the header already says them. Without a task (a session in a repo root, task proposals)
 * there is nothing. The tile's `overlay` decides what is open, shared with the task menu.
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
  overlay,
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
  overlay: TileOverlayState;
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
  const [seen, setSeen] = useState<ReadonlySet<string>>();
  const panel = useRef<HTMLElement>(null);
  const { opened } = overlay;
  const shown = opened?.kind === "notices" || opened?.kind === "mise-config" ? opened : undefined;
  const warningKeys = details.notices.filter((n) => n.tone === "warning").map((n) => n.key);
  if (seen === undefined && details.warningsChecked) setSeen(new Set(warningKeys));
  const unseen = seen ? newWarnings(details.notices, seen) : [];
  // Warnings that came while the overlay was open have been read there.
  const markSeen = () => setSeen(new Set([...(seen ?? []), ...warningKeys]));
  const openFor = (notice: TaskNotice | undefined) => {
    markSeen();
    overlay.open(notice?.section === "mise-config" ? { kind: "mise-config" } : { kind: "notices", section: notice?.section });
  };
  const close = () => {
    markSeen();
    overlay.close();
  };
  const section = shown?.kind === "notices" ? shown.section : undefined;
  useEffect(() => {
    if (!shown) return;
    panel.current?.focus();
    if (section) scrollToSection(panel.current, section);
  }, [shown, section]);
  if (!task) return { chips: null, overlay: null, details };
  const tile = tileNotices(details.notices);
  const isOpen = (notice: TaskNotice) => (notice.section === "mise-config" ? shown?.kind === "mise-config" : section === notice.section);

  return {
    chips: (
      <>
        {tile.chips.map((notice) => (
          <TileNoticeChip
            key={notice.key}
            ref={notice.section === "mise-config" ? overlay.trigger("mise-config") : undefined}
            notice={notice}
            open={isOpen(notice)}
            onToggle={() => (isOpen(notice) ? close() : openFor(notice))}
          >
            {notice.tone === "warning" ? <ShieldAlert className="size-3" aria-hidden /> : <ShieldCheck className="size-3" aria-hidden />}
            {/* A narrow tile keeps the verification's colour and icon; the mise chip says what to do, so it keeps its text. */}
            <span className={cn(notice.section === "verification" && "@max-sm:hidden")}>{notice.chip}</span>
          </TileNoticeChip>
        ))}
        <NoticeBadge
          ref={overlay.trigger("notices")}
          notices={tile.others}
          open={shown?.kind === "notices" && section === undefined}
          onToggle={() => (shown?.kind === "notices" ? close() : openFor(undefined))}
        />
      </>
    ),
    details,
    // Hidden rather than unmounted when closed, so that a section keeps what the user did in it (the mise config shown
    // for trust, an open log). From the bottom: the overlays (the environment card, then these), the line of a new
    // warning (z-20), so that no overlay hides it, and the close question (z-30), which the user is answering.
    overlay: (
      <>
        <TileOverlay
          ref={panel}
          open={shown !== undefined}
          label={shown?.kind === "mise-config" ? "mise config overlay" : "Task notices overlay"}
          onEscape={close}
        >
          <div className="flex items-center gap-2 border-b px-2 py-1">
            {shown?.kind === "mise-config" ? (
              <span className="flex flex-1 justify-end">
                <TaskEditorButton conn={conn} task={task} label="Open in VS Code" />
              </span>
            ) : (
              <NoticeChips notices={details.notices} onOpen={(s) => scrollToSection(panel.current, s)} />
            )}
            <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={close} aria-label="Close task notices">
              <X />
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto">
            <TaskDetails
              conn={conn}
              task={task}
              details={details}
              sessions={sessions}
              onOpenTask={onOpenTask}
              only={shown?.kind === "mise-config" ? "mise-config" : undefined}
            />
          </div>
        </TileOverlay>
        <NewWarningBanner unseen={opened ? [] : unseen} onShow={() => openFor(unseen[0])} onDismiss={markSeen} />
      </>
    ),
  };
}

/**
 * The line of a warning that came while the grid is open, over the terminal until the user opens or dismisses it.
 * Mounted while the tile is, so that a screen reader announces the warning when its text comes.
 */
function NewWarningBanner({ unseen, onShow, onDismiss }: { unseen: readonly TaskNotice[]; onShow: () => void; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        unseen.length > 0
          ? "bg-overlay border-warning/50 text-warning absolute inset-x-1 top-1 z-20 flex items-center gap-2 rounded-md border px-2 py-1 text-xs shadow-lg"
          : "sr-only",
      )}
    >
      {unseen.length > 0 && (
        <>
          <span className="min-w-0 flex-1 truncate">
            {unseen[0]?.label}
            {unseen.length > 1 && ` and ${unseen.length - 1} more`}
          </span>
          <Button variant="outline" size="sm" className="h-6 shrink-0" onClick={onShow}>
            Show
          </Button>
          <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onDismiss} aria-label="Dismiss the warning">
            <X />
          </Button>
        </>
      )}
    </div>
  );
}
