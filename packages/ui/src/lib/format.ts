/** Formatowanie dla widoków repo; czyste funkcje, testowane w `test/format.test.ts`. */

import { countLabel } from "@trackwall/protocol";

/** Przypis pod ucięty plik (README albo podgląd); daemon zwraca tylko początek dużych plików. */
export const TRUNCATED_NOTE = "The file is longer; showing the beginning.";

export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** Czas działania daemona: sekundy, minuty albo godziny z minutami. */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
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

/**
 * Zmiany w katalogu roboczym z nowymi osobno, bo „4 changes” nie mówi, czy coś zmieniono, czy tylko przybyło:
 * „3 changed, 1 new”. Nowe to wpisy `git status`, więc nowy katalog to jeden wpis, a nie liczba jego plików.
 * `undefined`, gdy repo jest czyste.
 */
export function workingTreeLabel(changed: number, untracked: number): string | undefined {
  const parts = [changed > 0 ? `${changed} changed` : undefined, untracked > 0 ? `${untracked} new` : undefined].filter(
    (p) => p !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** Liczba zmian w katalogu roboczym jako tekst; `undefined`, gdy repo jest czyste. */
export function changesLabel(changes: number): string | undefined {
  return changes === 0 ? undefined : countLabel(changes, { one: "change", other: "changes" });
}

/** Liczba z co najmniej dwiema cyframi, jak numery na liście repo: 1 daje „01”, 12 daje „12”. */
export function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}
