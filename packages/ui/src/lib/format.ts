/** Formatowanie dla widoków repo; czyste funkcje, testowane w `test/format.test.ts`. */

export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return "przed chwilą";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min temu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h temu`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "wczoraj" : `${days} dni temu`;
  return new Date(iso).toLocaleDateString("pl-PL");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Okruszki dla ścieżki w repo: `a/b` daje korzeń, `a` i `a/b`. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: "/", path: "" }];
  if (path === "") return crumbs;
  const parts = path.split("/");
  return [...crumbs, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }))];
}

/** Liczba zmian w katalogu roboczym jako tekst; `undefined`, gdy repo jest czyste. */
export function changesLabel(changes: number): string | undefined {
  if (changes === 0) return undefined;
  if (changes === 1) return "1 zmiana";
  const lastDigit = changes % 10;
  const teen = changes % 100 >= 12 && changes % 100 <= 14;
  return `${changes} ${lastDigit >= 2 && lastDigit <= 4 && !teen ? "zmiany" : "zmian"}`;
}

/** Numer slotu w stylu HUD, co najmniej dwie cyfry: 1 daje „01”, 12 daje „12”. */
export function slotNumber(n: number): string {
  return String(n).padStart(2, "0");
}
