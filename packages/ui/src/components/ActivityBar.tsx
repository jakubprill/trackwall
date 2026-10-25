import type { LucideIcon } from "lucide-react";
import { IS_MAC } from "@/lib/platform";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import { cn } from "@/lib/utils";
import { ariaShortcut, shortcutLabel, type ViewShortcut, viewKeyAction } from "@/lib/view-shortcut";

export type ActivityView<Id extends string> = {
  id: Id;
  label: string;
  icon: LucideIcon;
  shortcut: ViewShortcut;
  /** Work views are at the top of the bar, and settings and the app state at the bottom edge, as in VS Code. */
  placement: "top" | "bottom";
};

/**
 * The view bar at the left edge of the window (like the activity bar in VS Code): an icon per view, the name and shortcut
 * in a tooltip, the active view with a glowing stroke (ADR-16).
 */
export function ActivityBar<Id extends string>({
  views,
  active,
  onSelect,
  newWindow,
  badges = {},
}: {
  views: readonly ActivityView<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Views in new windows (ADR-49): the Ctrl+Shift shortcuts and the icon's context menu; absent outside the shell. */
  newWindow?: { open: (id: Id) => void; showMenu: (id: Id) => void };
  /** The number at a view's icon, for example sessions waiting for you; zero and none show nothing. */
  badges?: Partial<Record<Id, number>>;
}) {
  useViewShortcuts(views, active, onSelect, newWindow?.open);

  const group = (placement: ActivityView<Id>["placement"]) =>
    views
      .filter((v) => v.placement === placement)
      .map((v) => (
        <ActivityButton
          key={v.id}
          view={v}
          active={v.id === active}
          badge={badges[v.id]}
          onSelect={() => onSelect(v.id)}
          onContextMenu={newWindow && (() => newWindow.showMenu(v.id))}
        />
      ));

  return (
    <nav aria-label="Views" className="bg-card w-activity-bar flex shrink-0 flex-col border-r">
      <img src="/favicon.png" alt="Trackwall" title="Trackwall" className="mx-auto my-3 size-6" />
      <ul className="flex flex-col">{group("top")}</ul>
      <ul className="mt-auto flex flex-col pb-1">{group("bottom")}</ul>
    </nav>
  );
}

/** Shortcuts work in the whole window, also when the focus is in a text field or a session terminal. */
function useViewShortcuts<Id extends string>(
  views: readonly ActivityView<Id>[],
  active: Id,
  onSelect: (id: Id) => void,
  onOpenInNewWindow: ((id: Id) => void) | undefined,
) {
  useWindowShortcuts(
    (event) => viewKeyAction(event, views, active, { isMac: IS_MAC, newWindows: onOpenInNewWindow !== undefined }),
    (action) => {
      if (action.kind === "select") onSelect(action.id);
      if (action.kind === "new-window") onOpenInNewWindow?.(action.id);
      return true;
    },
  );
}

function ActivityButton<Id extends string>({
  view,
  active,
  badge,
  onSelect,
  onContextMenu,
}: {
  view: ActivityView<Id>;
  active: boolean;
  badge: number | undefined;
  onSelect: () => void;
  onContextMenu: (() => void) | undefined;
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
        onContextMenu={
          onContextMenu &&
          ((event) => {
            event.preventDefault();
            onContextMenu();
          })
        }
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
