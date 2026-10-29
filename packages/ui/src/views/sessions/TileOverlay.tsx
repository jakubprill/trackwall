import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * A panel that lies over a grid tile's terminal (ADR-91, ADR-93), so that opening it does not resize the PTY. It takes
 * the keyboard when shown (the caller focuses it through `ref`), so that Escape closes it instead of reaching the
 * terminal. Hidden rather than unmounted, so that what the user did in it stays.
 */
export function TileOverlay({
  ref,
  open,
  label,
  onEscape,
  className,
  children,
  ...hover
}: {
  ref: Ref<HTMLElement>;
  open: boolean;
  label: string;
  onEscape: () => void;
  className?: string;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <section
      ref={ref}
      tabIndex={-1}
      hidden={!open}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscape();
      }}
      {...hover}
      className={cn(
        "bg-card absolute inset-x-1 top-1 z-10 flex max-h-2/3 flex-col overflow-hidden rounded-md border shadow-lg outline-none",
        className,
      )}
    >
      {children}
    </section>
  );
}
