import { IS_MAC } from "@/lib/platform";
import { ariaTabShortcut, steppedTab, tabShortcut, tabShortcutLabel } from "@/lib/tab-shortcut";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import { cn } from "@/lib/utils";

const SHORTCUT_HINT = `${tabShortcutLabel(IS_MAC)} switch tabs`;
const ARIA_SHORTCUT = ariaTabShortcut(IS_MAC);

/**
 * A tab bar in a view's content, for example in the Repo view. `ActivityBar` switches the app's views. Ctrl+PageDown
 * and Ctrl+PageUp (⌘⇧] and ⌘⇧[ on macOS) step through its tabs from anywhere in the window, a session terminal
 * included (ADR-211); a view shows one tab bar at a time, so the shortcut has one owner. Tabs that do not fit the width
 * (a small screen with the supervisor panel pinned) go on to a second row instead of being cut off.
 */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
}: {
  /** `count` is a red number after the label, for what waits in the tab (the failed tests of a task, ADR-304); none at 0. */
  tabs: readonly { id: Id; label: string; count?: number }[];
  active: Id;
  onSelect: (id: Id) => void;
}) {
  useWindowShortcuts(
    (event) => tabShortcut(event, IS_MAC),
    (step) => {
      // A bar with one tab leaves the key alone, as a window shortcut does when it has nothing to do.
      const next = steppedTab(tabs, active, step);
      if (next === active) return false;
      onSelect(next);
      return true;
    },
  );
  return (
    <div role="tablist" title={SHORTCUT_HINT} aria-keyshortcuts={ARIA_SHORTCUT} className="flex flex-wrap gap-x-1 border-b">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onSelect(t.id)}
          aria-label={t.count ? `${t.label} (${t.count})` : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
            active === t.id
              ? "border-primary text-foreground font-medium"
              : "text-muted-foreground border-transparent hover:text-foreground",
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span aria-hidden className="bg-destructive text-foreground ml-1.5 rounded-full px-1.5 font-mono text-xs font-medium">
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
