import type { ProviderModel } from "@trackwall/protocol";
import { TriangleAlert } from "lucide-react";
import { unofferedModel } from "@/lib/provider-models";
import { cn } from "@/lib/utils";

/**
 * The warning next to a Model field when the session profile's provider does not offer the typed id (ADR-206), with the
 * closest id it does offer as a button that takes it. Only a warning: the list may be a few minutes old, and the user
 * may know better.
 */
export function UnofferedModelNote({
  typed,
  models,
  onPick,
  className,
}: {
  typed: string;
  models: readonly ProviderModel[];
  onPick: (model: string) => void;
  className?: string;
}) {
  const unoffered = unofferedModel(typed, models);
  if (unoffered === null) return null;
  const { closest } = unoffered;
  return (
    <span role="status" className={cn("text-warning inline-flex min-w-0 items-center gap-1 text-xs", className)}>
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      <span className="truncate">The provider does not offer it{closest === null ? "" : "; did you mean"}</span>
      {closest !== null && (
        <button type="button" className="shrink-0 font-mono underline underline-offset-2" onClick={() => onPick(closest)}>
          {closest}?
        </button>
      )}
    </span>
  );
}
