import { cn } from "@/lib/utils";

const STYLES = {
  pills: { bar: "", tab: "rounded-md px-3 py-1", active: "bg-accent font-medium", idle: "text-muted-foreground hover:text-foreground" },
  underline: {
    bar: "border-b",
    tab: "-mb-px border-b-2 px-3 py-2",
    active: "border-foreground font-medium",
    idle: "text-muted-foreground border-transparent hover:text-foreground",
  },
};

/** Pasek zakładek: widoki w nagłówku aplikacji (`pills`) i zakładki repo (`underline`). */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
  variant,
}: {
  tabs: readonly { id: Id; label: string }[];
  active: Id;
  onSelect: (id: Id) => void;
  variant: keyof typeof STYLES;
}) {
  const style = STYLES[variant];
  return (
    <div role="tablist" className={cn("flex gap-1", style.bar)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn("text-sm", style.tab, active === t.id ? style.active : style.idle)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
