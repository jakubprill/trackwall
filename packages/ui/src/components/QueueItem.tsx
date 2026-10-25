import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** An item of a queue (the dashboard's "Needs you", the tray panel): the title, with the status on one line below it. */
export function QueueItem({
  title,
  active,
  onClick,
  onDoubleClick,
  children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={active || undefined}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        className={cn(
          "flex w-full flex-col items-start gap-1 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
          active && "bg-accent border-primary/25 hud-active-edge",
        )}
      >
        <span className="w-full truncate text-sm font-medium">{title}</span>
        <span className="text-xs">{children}</span>
      </button>
    </li>
  );
}
