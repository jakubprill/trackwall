import { cn } from "@/lib/utils";

/** Aktywna zakładka dostaje akcent z poświatą przy dolnej krawędzi; `-mb-px` kładzie ją na linii nagłówka. */
const STYLES = {
  nav: {
    bar: "self-stretch",
    tab: "-mb-px flex items-center border-b-2 px-3 font-mono text-xs tracking-[0.12em] uppercase",
    active: "border-primary text-foreground [box-shadow:0_6px_12px_-8px_var(--primary)]",
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
