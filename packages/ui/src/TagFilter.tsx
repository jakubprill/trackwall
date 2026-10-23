import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Filtr listy repo po tagach (ADR-25): każdy tag z liczbą repo; wybrane zawężają listę (repo musi mieć wszystkie).
 * Tagi liczy daemon z kart repo i z reguł `repoTags` w `workspace.yaml`.
 */
export function TagFilter({
  counts,
  selected,
  onToggle,
  onClear,
}: {
  counts: { name: string; count: number }[];
  selected: readonly string[];
  onToggle: (name: string) => void;
  onClear: () => void;
}) {
  if (counts.length === 0) return null;
  return (
    <fieldset aria-label="Filtr po tagach" className="flex flex-wrap items-center gap-1 px-4 pb-3">
      {counts.map(({ name, count }) => {
        const active = selected.includes(name);
        return (
          <button
            key={name}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(name)}
            className={cn(
              "text-2xs rounded-sm border px-1.5 py-0.5 font-mono transition-colors",
              active ? "border-primary/40 bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-accent",
            )}
          >
            #{name} <span className="opacity-70">{count}</span>
          </button>
        );
      })}
      {selected.length > 0 && (
        <Button variant="ghost" size="sm" onClick={onClear} aria-label="Wyczyść filtr tagów">
          <X /> wyczyść
        </Button>
      )}
    </fieldset>
  );
}
