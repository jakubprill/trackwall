import { cn } from "@/lib/utils";

/** Pasek zakładek: widoki w nagłówku aplikacji i zakładki repo. */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
  variant,
}: {
  tabs: readonly { id: Id; label: string }[];
  active: Id;
  onSelect: (id: Id) => void;
  variant: "pills" | "underline";
}) {
  return (
    <div role="tablist" className={cn("flex gap-1", variant === "underline" && "border-b")}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "text-sm",
            variant === "pills" && "rounded-md px-3 py-1",
            variant === "pills" && (active === t.id ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"),
            variant === "underline" && "-mb-px border-b-2 px-3 py-2",
            variant === "underline" &&
              (active === t.id ? "border-foreground font-medium" : "text-muted-foreground border-transparent hover:text-foreground"),
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
