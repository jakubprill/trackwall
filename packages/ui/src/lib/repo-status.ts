import type { RepoStatus, RepoStatusOk } from "@trackwall/protocol";
import { changesLabel } from "./format.ts";

/** Ton stanu w UI; kolor do tonu dobiera `StatusLabel`, a tokeny są w `index.css` (ADR-16). */
export type StatusTone = "ok" | "warning" | "error";

/**
 * Stan repo w jednej linii (§4.5): ton kropki i tekst obok niej. Jedno miejsce reguły
 * „niedostępne = błąd, zmiany w katalogu roboczym = ostrzeżenie, czysto = ok” dla listy i nagłówka repo.
 */
export function repoStatusTone(status: RepoStatus): { tone: StatusTone; label: string } {
  if (status.kind !== "ok") return { tone: "error", label: "unavailable" };
  const changes = changesLabel(status.changes);
  return changes ? { tone: "warning", label: changes } : { tone: "ok", label: "clean" };
}

export function branchLabel(status: RepoStatusOk): string {
  return status.branch ?? "detached HEAD";
}
