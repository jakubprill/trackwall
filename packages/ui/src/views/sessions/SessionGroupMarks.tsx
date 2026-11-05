import { LayoutGrid, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The marks of a group of related sessions (`lib/session-groups.ts`): the stripe along its rows and the top edge of its
 * tiles, the level next to a row's name, the button that shows the group alone in the grid and the chip of that filter.
 * One class per colour, written out, since Tailwind only builds class names it can find in the source.
 */
const FILL = ["bg-group-1", "bg-group-2", "bg-group-3", "bg-group-4"] as const;
const TONE = [
  "text-group-1 border-group-1/50",
  "text-group-2 border-group-2/50",
  "text-group-3 border-group-3/50",
  "text-group-4 border-group-4/50",
] as const;
const CHIP = ["bg-group-1/10", "bg-group-2/10", "bg-group-3/10", "bg-group-4/10"] as const;

/** A bar in the group's colour; the caller places it (along a row, across a tile's top). */
export function GroupStripe({ colour, className }: { colour: number; className: string }) {
  return <span aria-hidden className={cn("pointer-events-none absolute rounded-full", FILL[colour], className)} />;
}

/** How many levels a row sits under its group's top row, as ↳1, ↳2: past the third level the indent stops growing. */
export function GroupLevel({ colour, level }: { colour: number; level: number }) {
  if (level === 0) return null;
  return (
    <span className={cn("shrink-0 rounded-sm border px-1 font-mono text-2xs", TONE[colour])}>
      <span aria-hidden>{`↳${level}`}</span>
      <span className="sr-only">{`${level} ${level === 1 ? "level" : "levels"} under its main session`}</span>
    </span>
  );
}

/** Shows the row's group alone in the grid. */
export function ShowGroupButton({ onClick, className }: { onClick: () => void; className: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show only this group in the grid"
      aria-label="Show only this group in the grid"
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-secondary flex items-center gap-1 rounded-sm px-1 font-mono text-2xs transition-opacity",
        className,
      )}
    >
      <LayoutGrid className="size-3" aria-hidden />
      group
    </button>
  );
}

/** The grid filter to one group on the layout bar, in the group's colour, with an × that shows every entry again. */
export function GroupFilterChip({ colour, name, size, onClear }: { colour: number; name: string; size: number; onClear: () => void }) {
  return (
    <span
      className={cn("flex min-w-0 shrink items-center gap-1 rounded-full border py-px pr-0.5 pl-2.5 text-xs", TONE[colour], CHIP[colour])}
    >
      <span className="truncate">{`Group: ${name} · ${size}`}</span>
      <button type="button" onClick={onClear} aria-label="Show every entry" className="hover:bg-secondary rounded-full p-0.5">
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}
