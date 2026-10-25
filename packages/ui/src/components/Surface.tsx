import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A surface's header: a HUD caption (capitals) or a path in the repo, shown literally and in full in the tooltip. */
type Heading = { label: string; path?: never } | { path: string; label?: never } | { label?: never; path?: never };

/**
 * A glass surface: a shared frame for lists, previews, tiles and panels, so that every view has the same edges, spacing
 * and transparency (ADR-11, ADR-16). `meta` stands on the right in the header, `note` is a footnote under the content
 * (for example that the file is cut).
 */
export function Surface({ label, path, meta, note, children }: Heading & { meta?: ReactNode; note?: string; children: ReactNode }) {
  const heading = label ?? path;
  return (
    <section className="surface min-w-0 overflow-hidden">
      {heading !== undefined && (
        <header className="flex min-h-9 items-center justify-between gap-3 border-b px-3 py-2">
          <span className={cn("min-w-0 truncate", label ? "hud-label" : "text-muted-foreground font-mono text-xs")} title={path}>
            {heading}
          </span>
          {meta !== undefined && <span className="text-muted-foreground shrink-0 font-mono text-xs">{meta}</span>}
        </header>
      )}
      {children}
      {note && <p className="text-muted-foreground border-t px-3 py-2 text-xs">{note}</p>}
    </section>
  );
}
