import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Nagłówek powierzchni: podpis HUD (wersaliki) albo ścieżka w repo, pokazana dosłownie i w całości w podpowiedzi. */
type Heading = { label: string; path?: never } | { path: string; label?: never } | { label?: never; path?: never };

/**
 * Szklana powierzchnia: wspólna ramka dla list, podglądów, kafelków i paneli, żeby każdy widok miał
 * te same krawędzie, odstępy i przezroczystość (ADR-11, ADR-16). `meta` stoi po prawej w nagłówku,
 * `note` to przypis pod treścią (np. że plik jest ucięty).
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
