import type { RunningMiseTask, Session, Task, TaskMessage } from "@trackwall/protocol";
import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { newWarnings, type TaskNoticeTone, type TaskSection, tileNotices } from "@/lib/task-notices";
import { useTaskDetails } from "@/lib/use-task-details";
import { cn } from "@/lib/utils";
import { TaskEditorButton } from "./TaskButtons.tsx";
import { scrollToSection, TaskDetails } from "./TaskDetails.tsx";
import { TaskMiseConfig } from "./TaskMiseConfig.tsx";
import { NoticeBadge, NoticeChips, TileNoticeChip } from "./TaskNotices.tsx";
import { TileOverlay } from "./TileOverlay.tsx";

/** A selected tile checks its warnings as often as the task panel, the others less often: each check reads git. */
const UNSELECTED_WARNING_POLL_MS = 15_000;

/** What lies over the tile's terminal: all of the task's sections, or only its mise config to trust. */
type Opened = { kind: "notices"; section?: TaskSection } | { kind: "mise-config" };

/**
 * A task's notices on a grid tile (ADR-91): in the tile's header a chip for the mise config while mise tasks wait for
 * the user's trust, a chip for the verification and a badge for the rest (`tileNotices`). The badge and the
 * verification chip open the task's sections as an overlay over the terminal, so that the terminal keeps its size;
 * the mise chip opens only the mise config with Trust and VS Code. A warning that shows up while the grid is open lies
 * over the terminal as one line until the user opens or closes it. Warnings the task had when the tile appeared count
 * as seen: the header already says them. Without a task (a session in a repo root, task proposals) there is nothing.
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
  const [opened, setOpened] = useState<Opened>();
  const [seen, setSeen] = useState<ReadonlySet<string>>();
  const notices = useRef<HTMLElement>(null);
  const miseConfig = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const warningKeys = details.notices.filter((n) => n.tone === "warning").map((n) => n.key);
  if (seen === undefined && details.warningsChecked) setSeen(new Set(warningKeys));
  const unseen = seen ? newWarnings(details.notices, seen) : [];
  const markSeen = () => setSeen(new Set([...(seen ?? []), ...warningKeys]));
  const open = (next: Opened) => {
    // What had the keyboard (the chip or badge pressed) gets it back on close; WebKit does not focus a clicked button.
    if (!opened) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    markSeen();
    setOpened(next);
  };
  // Warnings that came while an overlay was open have been read there; the keyboard goes back to what opened it.
  const close = () => {
    markSeen();
    setOpened(undefined);
    opener.current?.focus();
  };
  const toggle = (next: Opened) => (opened?.kind === next.kind ? close() : open(next));
  const section = opened?.kind === "notices" ? opened.section : undefined;
  useEffect(() => {
    if (opened?.kind === "notices") {
      notices.current?.focus();
      if (section) scrollToSection(notices.current, section);
    } else if (opened?.kind === "mise-config") miseConfig.current?.focus();
  }, [opened?.kind, section]);
  if (!task) return { chips: null, overlay: null, openDetails: () => {}, verification: details.verification };
  const tile = tileNotices(details.notices);

  return {
    chips: (
      <>
        {tile.miseConfig && (
          <TileNoticeChip
            notice={tile.miseConfig.notice}
            open={opened?.kind === "mise-config"}
            onToggle={() => toggle({ kind: "mise-config" })}
          >
            <ShieldAlert className="size-3" aria-hidden />
            {tile.miseConfig.needsTrust && <span className="@max-sm:hidden">Trust</span>}
            mise
          </TileNoticeChip>
        )}
        {tile.verification && (
          <TileNoticeChip
            notice={tile.verification}
            open={section === "verification"}
            onToggle={() => (section === "verification" ? close() : open({ kind: "notices", section: "verification" }))}
          >
            <ShieldCheck className="size-3" aria-hidden />
            <span className="@max-sm:hidden">{VERIFICATION_CHIP[tile.verification.tone] ?? tile.verification.label}</span>
          </TileNoticeChip>
        )}
        <NoticeBadge notices={tile.others} open={opened?.kind === "notices"} onToggle={() => toggle({ kind: "notices" })} />
      </>
    ),
    /** The task's sections, for "Details" in the tile's task menu. */
    openDetails: () => open({ kind: "notices" }),
    verification: details.verification,
    // Hidden rather than unmounted when closed, so that a section keeps what the user did in it (the mise config shown
    // for trust, an open log). From the bottom: the overlays (the environment card, then these), the line of a new
    // warning (z-20), so that no overlay hides it, and the close question (z-30), which the user is answering.
    overlay: (
      <>
        <TileOverlay ref={notices} open={opened?.kind === "notices"} label="Task notices overlay" onEscape={close}>
          <div className="flex items-center gap-2 border-b px-2 py-1">
            <NoticeChips notices={details.notices} onOpen={(s) => scrollToSection(notices.current, s)} />
            <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={close} aria-label="Close task notices">
              <X />
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto">
            <TaskDetails conn={conn} task={task} details={details} sessions={sessions} onOpenTask={onOpenTask} />
          </div>
        </TileOverlay>
        <TileOverlay ref={miseConfig} open={opened?.kind === "mise-config"} label="mise config overlay" onEscape={close}>
          <div className="flex items-center justify-end gap-2 border-b px-2 py-1">
            <TaskEditorButton conn={conn} task={task} label="Open in VS Code" />
            <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={close} aria-label="Close the mise config">
              <X />
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto">
            <TaskMiseConfig conn={conn} task={task.id} remote={details.miseConfig} />
          </div>
        </TileOverlay>
        {/* Mounted while the tile is, so that a screen reader announces the warning when its text comes. */}
        <div
          role="status"
          className={cn(
            !opened && unseen.length > 0
              ? "bg-overlay border-warning/50 text-warning absolute inset-x-1 top-1 z-20 flex items-center gap-2 rounded-md border px-2 py-1 text-xs shadow-lg"
              : "sr-only",
          )}
        >
          {!opened && unseen.length > 0 && (
            <>
              <span className="min-w-0 flex-1 truncate">
                {unseen[0]?.label}
                {unseen.length > 1 && ` and ${unseen.length - 1} more`}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 shrink-0"
                onClick={() => open(unseen[0]?.section === "mise-config" ? { kind: "mise-config" } : { kind: "notices" })}
              >
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

/** The verification chip's short word; its tooltip has the full notice. */
const VERIFICATION_CHIP: Partial<Record<TaskNoticeTone, string>> = { running: "Verifying", passed: "Passed", failed: "Failed" };
