import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Filtering the repo list by tags (ADR-25): every tag with its number of repos; the chosen ones narrow the list (a repo
 * must have all of them). The daemon computes the tags from the repo cards and the `repoTags` rules in `workspace.yaml`.
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
    <fieldset aria-label="Filter by tags" className="flex flex-wrap items-center gap-1 px-4 pb-3">
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
        <Button variant="ghost" size="sm" onClick={onClear} aria-label="Clear the tag filter">
          <X /> clear
        </Button>
      )}
    </fieldset>
  );
}
