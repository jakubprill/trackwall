import { cn } from "@/lib/utils";

/** A tab bar in a view's content, for example in the Repo view. `ActivityBar` switches the app's views. */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly { id: Id; label: string }[];
  active: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b">
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
