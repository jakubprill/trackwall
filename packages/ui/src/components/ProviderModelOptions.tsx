import type { ProviderModel } from "@trackwall/protocol";
import { modelHint } from "@/lib/provider-models";

/**
 * The models of the session profile's provider as suggestions of a Model field (ADR-194), for an input's `list`: the
 * browser offers them as the user types, and any other id can still be typed.
 */
export function ProviderModelOptions({ id, models }: { id: string; models: readonly ProviderModel[] }) {
  return (
    <datalist id={id}>
      {models.map((model) => (
        <option key={model.id} value={model.id} label={modelHint(model) || undefined} />
      ))}
    </datalist>
  );
}
