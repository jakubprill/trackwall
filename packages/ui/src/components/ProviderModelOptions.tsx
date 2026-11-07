import type { ProviderModel } from "@trackwall/protocol";
import { modelSuggestions } from "@/lib/provider-models";

/**
 * The models of the session profile's provider as suggestions of a Model field (ADR-194), for an input's `list`: the
 * browser offers them as the user types, and any other id can still be typed. `auto` comes first (`modelSuggestions`).
 */
export function ProviderModelOptions({ id, models }: { id: string; models: readonly ProviderModel[] }) {
  return (
    <datalist id={id}>
      {modelSuggestions(models).map((model) => (
        <option key={model.id} value={model.id} label={model.hint || undefined} />
      ))}
    </datalist>
  );
}
