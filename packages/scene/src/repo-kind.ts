/**
 * Model repo na pulpicie zależy od warstwy (ADR-33): wejście (pierwsza warstwa, np. frontend) to terminal z ekranem,
 * brama (druga warstwa, gdy są co najmniej cztery, np. BFF) to walec z anteną, serwis (środek grafu i repo bez
 * połączeń) to szafa z diodami, a biblioteka (ostatnia warstwa) to skrzynka. Przy trzech warstwach i mniej środek to
 * same serwisy, bo druga warstwa nie odróżnia się jeszcze od reszty. Kształt mówi, gdzie repo leży w grafie, bez
 * czytania etykiety.
 */
export type RepoKind = "terminal" | "gateway" | "rack" | "crate";

export function repoKind(layer: number | null, layerCount: number): RepoKind {
  if (layer === null || layerCount <= 1) return "rack";
  if (layer === 0) return "terminal";
  if (layer === layerCount - 1) return "crate";
  return layer === 1 && layerCount > 3 ? "gateway" : "rack";
}
