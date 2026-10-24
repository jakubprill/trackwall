import type { HomeRepoState, HomeSessionState } from "./home-model.ts";

/**
 * Kolory sceny przychodzą z tokenów UI (`packages/ui/src/index.css`, ADR-16), czytanych przez UI w chwili tworzenia
 * sceny, więc scena nie ma własnej palety, która rozjechałaby się z resztą aplikacji. Tokeny są w `oklch`, którego
 * three.js nie czyta, dlatego UI podaje je przeliczone na sRGB jako `#rrggbb`; scena sprawdza to przy tworzeniu.
 */
export interface ScenePalette {
  /** `--primary`: praca w toku, wybór, połączenia. */
  primary: string;
  /** `--warning`: czeka na Ciebie, lokalne zmiany. */
  warning: string;
  /** `--destructive`: błąd, repo niedostępne. */
  destructive: string;
  /** `--muted-foreground`: zakończone sesje, napisy na ekranach. */
  muted: string;
  /** `--secondary` bez przezroczystości: spokojny stan, czyste repo. */
  idle: string;
  /** `--card` bez przezroczystości: korpusy modeli. */
  body: string;
  /** `--background`: płyty pod modelami. */
  plate: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function assertScenePalette(palette: ScenePalette): void {
  for (const [name, color] of Object.entries(palette)) {
    if (!HEX_COLOR.test(color)) throw new Error(`Kolor sceny ${name} musi być w postaci #rrggbb, a jest ${color}`);
  }
}

export function repoStateColor(state: HomeRepoState, palette: ScenePalette): string {
  if (state === "changed") return palette.warning;
  if (state === "behind") return palette.primary;
  if (state === "unavailable") return palette.destructive;
  return palette.idle;
}

export function sessionStateColor(state: HomeSessionState, palette: ScenePalette): string {
  if (state === "attention") return palette.warning;
  if (state === "error") return palette.destructive;
  if (state === "working") return palette.primary;
  return palette.muted;
}
