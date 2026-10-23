import { resolve } from "node:path";

/** Czy dwie pełne ścieżki wskazują ten sam katalog; Windows i macOS mają domyślnie systemy plików bez rozróżniania wielkości liter. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const caseInsensitive = platform === "win32" || platform === "darwin";
  return caseInsensitive ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
