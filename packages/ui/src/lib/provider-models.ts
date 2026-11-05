import type { ProviderModel, ProviderModelList } from "@trackwall/protocol";

/**
 * What the Model fields say about the models of the session profile's provider (ADR-194): a hint beside each suggested
 * id, and the line under the session profile in Settings that tells whether the list came.
 */

/**
 * The hint beside a suggested model: its context window rounded to thousands of tokens, and the one format it answers
 * in once a session found it out (ADR-200); empty when neither is known.
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

/** Copilot CLI's own choice of model, which no provider lists, so a Model field never warns about it. */
export const COPILOT_AUTO_MODEL = "auto";

/**
 * A model id the provider does not offer (ADR-206), with the offered id closest to it: a task proposed on an older
 * model, or a typo, fails only at its first turn, and a task keeps its model, so the field says so before the start.
 * `null` when there is nothing to warn about: an empty or invalid field, no list, `auto`, or an offered id.
 */
export function unofferedModel(typed: string, models: readonly ProviderModel[]): { closest: string | null } | null {
  const id = typed.trim();
  if (id === "" || id === COPILOT_AUTO_MODEL || models.length === 0) return null;
  if (models.some((model) => model.id === id)) return null;
  let closest: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const model of models) {
    const distance = editDistance(id.toLowerCase(), model.id.toLowerCase());
    if (distance < best) {
      best = distance;
      closest = model.id;
    }
  }
  // Only an id close enough to be the same model under another version or spelling, not just any model of the list.
  return { closest: closest !== null && best <= Math.max(id.length, closest.length) / 2 ? closest : null };
}

/** The warning under a Model field, from `unofferedModel`. */
export function unofferedModelText(typed: string, closest: string | null): string {
  return `The provider does not offer ${typed.trim()}${closest === null ? "" : `; did you mean ${closest}?`}`;
}

/** Levenshtein distance: the edits that turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, substitution));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}
