import type { ProviderModel } from "@trackwall/protocol";
import { COPILOT_AUTO_MODEL, modelHint } from "@/lib/provider-models";

/**
 * The models of the session profile's provider as suggestions of a Model field (ADR-194), for an input's `list`: the
 * browser offers them as the user types, and any other id can still be typed. `auto` comes first: Copilot CLI picks
 * the model itself, and with a session profile it sends `auto` to the provider, which must know it.
 */
export function ProviderModelOptions({ id, models }: { id: string; models: readonly ProviderModel[] }) {
  return (
    <datalist id={id}>
      <option value={COPILOT_AUTO_MODEL} label="Copilot picks the model" />
      {models.map((model) => (
        <option key={model.id} value={model.id} label={modelHint(model) || undefined} />
      ))}
    </datalist>
  );
}
