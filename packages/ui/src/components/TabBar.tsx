import { IS_MAC } from "@/lib/platform";
import { ariaTabShortcut, steppedTab, tabShortcut, tabShortcutLabel } from "@/lib/tab-shortcut";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import { cn } from "@/lib/utils";

const SHORTCUT_HINT = `${tabShortcutLabel(IS_MAC)} switch tabs`;
const ARIA_SHORTCUT = ariaTabShortcut(IS_MAC);

/**
 * A tab bar in a view's content, for example in the Repo view. `ActivityBar` switches the app's views. Ctrl+PageDown
 * and Ctrl+PageUp (⌘⇧] and ⌘⇧[ on macOS) step through its tabs from anywhere in the window, a session terminal
 * included (ADR-211); a view shows one tab bar at a time, so the shortcut has one owner.
 */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly { id: Id; label: string }[];
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
    <div role="tablist" title={SHORTCUT_HINT} aria-keyshortcuts={ARIA_SHORTCUT} className="flex gap-1 border-b">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
            active === t.id
              ? "border-primary text-foreground font-medium"
              : "text-muted-foreground border-transparent hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
