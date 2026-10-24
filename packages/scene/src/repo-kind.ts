/**
 * Model repo na pulpicie zależy od warstwy (ADR-33): wejście (np. frontend) to terminal z ekranem, druga warstwa to
 * bramka, środek to szafa, ostatnia warstwa (biblioteki) to skrzynka. Kształt mówi, gdzie repo leży w grafie, bez
 * czytania etykiety.
 */
export type RepoKind = "terminal" | "gateway" | "rack" | "crate";

export function repoKind(layer: number, layerCount: number): RepoKind {
  if (layerCount <= 1) return "rack";
  if (layer === 0) return "terminal";
  if (layer === layerCount - 1) return "crate";
  return layer === 1 && layerCount > 3 ? "gateway" : "rack";
}
