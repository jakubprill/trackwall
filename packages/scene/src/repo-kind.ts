/**
 * Rodzaj repo na pulpicie wynika z warstwy (ADR-33): wejście (pierwsza warstwa, np. frontend), brama (druga warstwa,
 * gdy są co najmniej cztery, np. BFF), serwis (środek grafu i repo bez połączeń) i biblioteka (ostatnia warstwa).
 * Przy trzech warstwach i mniej środek to same serwisy, bo druga warstwa nie odróżnia się jeszcze od reszty. Każdy
 * rodzaj ma inną bryłę, więc kształt mówi, gdzie repo leży w grafie, bez czytania etykiety.
 */
export type RepoKind = "entry" | "gateway" | "service" | "library";

export function repoKind(layer: number | null, layerCount: number): RepoKind {
  if (layer === null || layerCount <= 1) return "service";
  if (layer === 0) return "entry";
  if (layer === layerCount - 1) return "library";
  return layer === 1 && layerCount > 3 ? "gateway" : "service";
}
