import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useId } from "react";

/**
 * A section that stays folded until asked for, one row of a list of them in a shared frame (the caller's `surface`
 * with `divide-y`): its header is a button with a chevron, the caption and `meta` on the right, and the content shows
 * under it while `open`.
 */
export function FoldedSection({
  label,
  meta,
  open,
  onOpen,
  children,
}: {
  label: string;
  meta?: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const content = useId();
  return (
    <section className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={content}
        onClick={() => onOpen(!open)}
        className="hover:bg-accent/40 focus-visible:ring-ring/50 flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-[3px]"
      >
        {open ? (
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        )}
        <span className="hud-label shrink-0">{label}</span>
        {meta !== undefined && <span className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs">{meta}</span>}
      </button>
      {open && (
        <div id={content} className="border-t">
          {children}
        </div>
      )}
    </section>
  );
}
