/**
 * A repo's kind on the dashboard follows from its layer (ADR-33): entry (first layer, for example a frontend), gateway
 * (second layer, when there are at least four, for example a BFF), backend (the middle of the graph and repos without
 * connections) and library (last layer). With three layers or fewer the middle is all backends, because the second layer
 * does not yet stand out from the rest. Every kind has a different solid, so the shape tells where a repo sits in the
 * graph without reading the label.
 */
export type RepoKind = "entry" | "gateway" | "backend" | "library";

export function repoKind(layer: number | null, layerCount: number): RepoKind {
  if (layer === null || layerCount <= 1) return "backend";
  if (layer === 0) return "entry";
  if (layer === layerCount - 1) return "library";
  return layer === 1 && layerCount > 3 ? "gateway" : "backend";
}
