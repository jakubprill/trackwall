import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Szklana powierzchnia z nagłówkiem: wspólna ramka dla list, podglądów i paneli, żeby każdy widok miał
 * te same krawędzie, odstępy i przezroczystość (ADR-11). `label` to podpis HUD (wielkie litery),
 * `path` to ścieżka w repo, pokazana dosłownie.
 */
export function Panel({
  label,
  path,
  meta,
  className,
  children,
}: {
  label?: string;
  path?: ReactNode;
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("bg-card text-card-foreground min-w-0 overflow-hidden rounded-lg border", className)}>
      {(label || path || meta) && (
        <header className="flex min-h-9 items-center justify-between gap-3 border-b px-3 py-2">
          <span className={cn("min-w-0 truncate", path ? "text-muted-foreground font-mono text-xs" : "hud-label")}>{path ?? label}</span>
          {meta && <span className="text-muted-foreground shrink-0 font-mono text-xs">{meta}</span>}
        </header>
      )}
      {children}
    </section>
  );
}
