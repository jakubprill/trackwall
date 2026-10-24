import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { ariaShortcut, matchesShortcut, shortcutLabel, type ViewShortcut } from "@/lib/view-shortcut";

export type ActivityView<Id extends string> = {
  id: Id;
  label: string;
  icon: LucideIcon;
  shortcut: ViewShortcut;
  /** Widoki pracy są u góry paska, a ustawienia i stan aplikacji przy dolnej krawędzi, jak w VS Code. */
  placement: "top" | "bottom";
};

/**
 * Pasek widoków przy lewej krawędzi okna (activity bar z VS Code): ikona na widok, nazwa i skrót w podpowiedzi,
 * aktywny widok ze świecącą kreską (ADR-16).
 */
export function ActivityBar<Id extends string>({
  views,
  active,
  onSelect,
  badges = {},
}: {
  views: readonly ActivityView<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Liczba przy ikonie widoku, np. sesje, które czekają na Ciebie; zero i brak nie pokazują niczego. */
  badges?: Partial<Record<Id, number>>;
}) {
  useViewShortcuts(views, onSelect);

  const group = (placement: ActivityView<Id>["placement"]) =>
    views
      .filter((v) => v.placement === placement)
      .map((v) => <ActivityButton key={v.id} view={v} active={v.id === active} badge={badges[v.id]} onSelect={() => onSelect(v.id)} />);

  return (
    <nav aria-label="Views" className="bg-card w-activity-bar flex shrink-0 flex-col border-r">
      <img src="/favicon.png" alt="Trackwall" title="Trackwall" className="mx-auto my-3 size-6" />
      <ul className="flex flex-col">{group("top")}</ul>
      <ul className="mt-auto flex flex-col pb-1">{group("bottom")}</ul>
    </nav>
  );
}

/** Skróty działają w całym oknie, także gdy fokus jest w polu tekstowym. */
function useViewShortcuts<Id extends string>(views: readonly ActivityView<Id>[], onSelect: (id: Id) => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const view = views.find((v) => matchesShortcut(event, v.shortcut, IS_MAC));
      if (!view) return;
      event.preventDefault();
      onSelect(view.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [views, onSelect]);
}

function ActivityButton<Id extends string>({
  view,
  active,
  badge,
  onSelect,
}: {
  view: ActivityView<Id>;
  active: boolean;
  badge: number | undefined;
  onSelect: () => void;
}) {
  const Icon = view.icon;
  const count = badge !== undefined && badge > 0 ? badge : undefined;
  return (
    <li>
      <button
        type="button"
        aria-label={count === undefined ? view.label : `${view.label} (waiting: ${count})`}
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts={ariaShortcut(view.shortcut, IS_MAC)}
        onClick={onSelect}
        className={cn(
          "group focus-visible:ring-ring/50 relative flex h-12 w-full items-center justify-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
          active ? "hud-active-edge text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon className="size-5" strokeWidth={1.75} />
        {count !== undefined && (
          <span
            aria-hidden
            className="bg-warning text-background shadow-glow-warning absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full font-mono text-2xs font-semibold"
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
        <span
          aria-hidden
          className="bg-background pointer-events-none absolute top-1/2 left-full z-10 ml-2 flex -translate-y-1/2 items-center gap-3 rounded-md border px-2 py-1 text-xs whitespace-nowrap opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <span className="text-foreground">{view.label}</span>
          <span className="text-muted-foreground font-mono text-2xs">{shortcutLabel(view.shortcut, IS_MAC)}</span>
        </span>
      </button>
    </li>
  );
}
