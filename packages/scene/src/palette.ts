import type { HomeRepoState, HomeSessionState } from "./home-model.ts";

/**
 * Kolory sceny przychodzą z tokenów UI (`packages/ui/src/index.css`, ADR-16), czytanych przez UI w chwili tworzenia
 * sceny, więc scena nie ma własnej palety, która rozjechałaby się z resztą aplikacji.
 */
export interface ScenePalette {
  /** `--primary`: praca w toku, wybór, połączenia. */
  accent: string;
  /** `--warning`: czeka na Ciebie, lokalne zmiany. */
  warning: string;
  /** `--destructive`: błąd, repo niedostępne. */
  destructive: string;
  /** `--muted-foreground`: zakończone, brak mise. */
  muted: string;
  /** Spokojny stan: czyste repo. */
  idle: string;
  /** Korpusy modeli. */
  body: string;
  /** Płyty pod modelami. */
  plate: string;
}

export function repoStateColor(state: HomeRepoState, palette: ScenePalette): string {
  if (state === "changed") return palette.warning;
  if (state === "behind") return palette.accent;
  if (state === "unavailable") return palette.destructive;
  return palette.idle;
}

export function sessionStateColor(state: HomeSessionState, palette: ScenePalette): string {
  if (state === "attention") return palette.warning;
  if (state === "error") return palette.destructive;
  if (state === "working") return palette.accent;
  return palette.muted;
}
