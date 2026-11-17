import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A placeholder for a piece of content that is loading (ADR-264): a quiet bar of the size the content will have, given
 * as classes (`h-5 w-40`), so the layout is already the final one. The first bar of a group says "Loading…" to a screen
 * reader through `Skeletons`.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("bg-secondary block animate-pulse rounded", className)} />;
}

/** A group of skeleton bars, announced once as loading. */
export function Skeletons({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-label="Loading…" className={className}>
      {children}
    </div>
  );
}
