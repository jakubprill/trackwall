import type { ProviderModel, ProviderModelList } from "@trackwall/protocol";

/**
 * What the Model fields say about the models of the session profile's provider (ADR-194): a hint beside each suggested
 * id, and the line under the session profile in Settings that tells whether the list came.
 */

/**
 * The hint beside a suggested model: its context window rounded to thousands of tokens, and the one format it answers
 * in once a session found it out (ADR-197); empty when neither is known.
 */
export function modelHint(model: ProviderModel): string {
  const parts: string[] = [];
  if (model.contextWindow !== null) {
    const thousands = model.contextWindow / 1000;
    parts.push(`${thousands >= 1000 ? `${thousands / 1000}M` : `${Math.round(thousands)}k`} context`);
  }
  if (model.wireApi !== null) parts.push(`${model.wireApi} API`);
  return parts.join(" · ");
}

/** The line under the session profile; `null` without a profile or a provider, when there is nothing to list. */
export function providerModelsNote(list: ProviderModelList): { text: string; problem: boolean } | null {
  if (list.problem !== null) return { text: list.problem, problem: true };
  if (list.profile === null) return null;
  const count = list.models.length;
  if (count === 0) return null;
  return {
    text: `The provider offers ${count === 1 ? "1 model" : `${count} models`}; the Model fields suggest them, and any other id can still be typed.`,
    problem: false,
  };
}
