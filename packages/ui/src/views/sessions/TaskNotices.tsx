import { countLabel } from "@trackwall/protocol";
import { ChevronDown, ChevronUp, Info, TriangleAlert } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { TaskNotice, TaskNoticeTone, TaskSection } from "@/lib/task-notices";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<TaskNoticeTone, string> = {
  warning: "border-warning/40 bg-warning/10 text-warning",
  failed: "bg-secondary text-destructive",
  passed: "bg-secondary text-success",
  running: "bg-secondary text-primary",
  info: "bg-secondary text-muted-foreground",
};

/**
 * A task's notices as chips (ADR-91), warnings first; a chip opens its section. The row never wraps: chips that do
 * not fit are cut, and the whole list is in the row's tooltip.
 */
export function NoticeChips({ notices, onOpen }: { notices: readonly TaskNotice[]; onOpen: (section: TaskSection) => void }) {
  return (
    <ul
      aria-label="Task notices"
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      title={notices.map((n) => n.label).join("\n")}
    >
      {notices.map((notice) => (
        <li key={notice.key} className="shrink-0">
          <button
            type="button"
            onClick={() => onOpen(notice.section)}
            className={cn(
              "flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-xs whitespace-nowrap",
              TONE_CLASS[notice.tone],
            )}
          >
            {notice.tone === "warning" && <TriangleAlert className="size-3" aria-hidden />}
            {notice.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The one line above the task's tabs in the one-entry layout: the notices folded, so that the terminal keeps the
 * panel's height, and "Details" to unfold the sections. Nothing when the task has no notices.
 */
export function TaskNoticeStrip({
  notices,
  open,
  onToggle,
  onOpen,
}: {
  notices: readonly TaskNotice[];
  open: boolean;
  onToggle: () => void;
  onOpen: (section: TaskSection) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className="flex items-center gap-2 border-b px-4 py-1.5">
      <NoticeChips notices={notices} onOpen={onOpen} />
      <button type="button" onClick={onToggle} aria-expanded={open} className="text-primary flex shrink-0 items-center gap-1 text-xs">
        Details {open ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
      </button>
    </div>
  );
}

/** A grid tile's badge: the number of warnings, or of other notices when there are none. Nothing without notices. */
export function NoticeBadge({
  ref,
  notices,
  open,
  onToggle,
}: {
  ref?: Ref<HTMLButtonElement>;
  notices: readonly TaskNotice[];
  open: boolean;
  onToggle: () => void;
}) {
  if (notices.length === 0) return null;
  const warnings = notices.filter((n) => n.tone === "warning").length;
  const label =
    warnings > 0
      ? countLabel(warnings, { one: "warning", other: "warnings" })
      : countLabel(notices.length, { one: "notice", other: "notices" });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`Task notices: ${label}`}
      title={notices.map((n) => n.label).join("\n")}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-xs",
        warnings > 0 ? "border-warning/40 bg-warning/10 text-warning" : "bg-secondary text-muted-foreground",
      )}
    >
      {warnings > 0 ? <TriangleAlert className="size-3" aria-hidden /> : <Info className="size-3" aria-hidden />}
      {warnings > 0 ? warnings : notices.length}
    </button>
  );
}

/**
 * A chip of its own in a grid tile's header for one notice (`tileNotices`): the mise config to trust and the
 * verification. Its full text is the tooltip, since the chip shortens it to fit a narrow tile.
 */
export function TileNoticeChip({
  ref,
  notice,
  open,
  onToggle,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  notice: TaskNotice;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={notice.label}
      title={notice.label}
      className={cn("flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-xs whitespace-nowrap", TONE_CLASS[notice.tone])}
    >
      {children}
    </button>
  );
}
