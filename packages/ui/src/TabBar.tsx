import { cn } from "@/lib/utils";

const STYLES = {
  /** Widoki w nagłówku aplikacji: pełna wysokość nagłówka, a `-mb-px` kładzie akcent na jego dolnej linii. */
  nav: {
    bar: "self-stretch",
    tab: "-mb-px flex items-center border-b-2 px-3 font-mono text-xs tracking-hud uppercase",
    active: "border-primary text-foreground",
    idle: "text-muted-foreground border-transparent hover:text-foreground",
  },
  underline: {
    bar: "border-b",
    tab: "-mb-px border-b-2 px-3 py-2 text-sm",
    active: "border-primary text-foreground font-medium",
    idle: "text-muted-foreground border-transparent hover:text-foreground",
  },
};

/** Pasek zakładek: widoki w nagłówku aplikacji (`nav`) i zakładki repo (`underline`). */
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
          className={cn("transition-colors", style.tab, active === t.id ? style.active : style.idle)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
